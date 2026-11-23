/**
 * Session Port — Host-side export/import operations.
 *
 * One operation serves both callers: the browser route and the agent tool call
 * these functions, so the archive format and the failure contract cannot drift
 * between them.
 *
 * Export reads the committed log through `sessionQuery.readSession` — the same
 * validated view the shipped log export uses — and writes DSH's canonical
 * session-log archive: one `session[.vN].jsonl` plus the referenced attachments
 * under `media/` and `files/`.
 *
 * Import parses that archive (or a bare `.jsonl`), restores its attachments,
 * and commits a brand-new persisted session through `sessionPersistence`. The
 * new session is deliberately standalone: parent/seed lineage is dropped so an
 * imported conversation never claims a parent that does not exist here.
 *
 * @module dsh-session-port/host
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { finished } from 'node:stream/promises';

import {
  errorText,
  iteratePlannedEntries,
  planAttachmentEntries,
  restoreAttachmentEntries,
} from './attachments.js';
import {
  SessionPortFormatError,
  collectAttachmentRefs,
  findRootLogEntry,
  isZipBuffer,
  parseSessionLog,
  rewriteAttachmentRefs,
  rewriteDeliveryIdentity,
  rewriteSeedMarkers,
  sanitizeFileName,
  serializeSessionLog,
  sessionLogFileName,
  subagentLogEntryName,
  validateEvents,
} from './format.js';
import { readZipEntries, streamZipEntries } from './zip.js';
import { throwIfAborted, waitForDrain } from './abort.js';

/** Format version assumed when no stored session can tell us the current one. */
export const FALLBACK_SESSION_FORMAT_VERSION = 4;
/** Upper bound on one import request body. */
export const DEFAULT_MAX_IMPORT_BYTES = 512 * 1024 * 1024;
/** Title event carried by the session log itself. */
const TITLE_EVENT = 'session/title';

/**
 * Imports this plugin created, keyed by the plugin context and mirrored to
 * `$DSH_HOME/session-port/imports.json` so a Host restart keeps the history
 * and its undo ability. Undo must never accept an id this plugin did not mint:
 * an arbitrary cold-session deletion could hit any pre-existing session. The
 * mirror file lives inside DSH_HOME and carries the same trust as the session
 * storage next to it.
 * @type {WeakMap<object, Map<string, Record<string, unknown>>>}
 */
const undoableImports = new WeakMap();

/** Contexts whose registry mirror could not be read (a torn read, etc.). */
const registryUnreadable = new WeakSet();

/** The plugin-owned directory under the DSH home. */
function pluginStateDirectory() {
  const home = process.env.DSH_HOME;
  const root = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh');
  return join(root, 'session-port');
}

/** The undo registry mirror file. */
function importsRegistryFile() {
  return join(pluginStateDirectory(), 'imports.json');
}

/**
 * The undo registry for one context, hydrating from the mirror file on first
 * use so a restarted Host sees the imports of its previous run.
 */
function undoablesOf(ctx) {
  let records = undoableImports.get(ctx);
  if (records !== undefined) return records;
  records = new Map();
  try {
    const parsed = JSON.parse(readFileSync(importsRegistryFile(), 'utf8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry !== null && typeof entry === 'object' && typeof entry.sessionId === 'string' && entry.sessionId !== '') {
          const { sessionId, ...info } = entry;
          records.set(sessionId, info);
        }
      }
    }
  } catch (error) {
    // A MISSING file starts empty; an UNREADABLE one (a torn read) must
    // not: persisting an empty map over it would silently erase every record.
    if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
      registryUnreadable.add(ctx);
    }
  }
  undoableImports.set(ctx, records);
  return records;
}

/** Write the registry mirror atomically; a failure only costs durability. */
function persistUndoables(ctx) {
  if (registryUnreadable.has(ctx)) return;
  try {
    const file = importsRegistryFile();
    // The registry names session titles and workspace membership: the same
    // trust level as the other DSH state files, so the same tight modes.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(file), 0o700);
    } catch {
      // Already owned correctly, or not ours to tighten; the file mode below
      // is the load-bearing part.
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(listUndoableImports(ctx), null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    console.warn('session-port: cannot persist the import registry:', error);
  }
}

/**
 * Record one freshly imported session as undoable, with the facts the import
 * history shows and undo needs (joined workspace, time, title, size).
 */
function registerUndoableImport(ctx, sessionId, info) {
  undoablesOf(ctx).set(sessionId, info);
  persistUndoables(ctx);
}

/**
 * The imports this plugin created, newest last, as the browser history
 * section and the undo route both see them.
 * @param {object} ctx - the plugin context.
 * @returns {Array<{sessionId: string} & Record<string, unknown>>} undoable imports.
 */
export function listUndoableImports(ctx) {
  return Array.from(undoablesOf(ctx), ([sessionId, info]) => ({ sessionId, ...info }));
}

/**
 * Resolve the optional composed services this plugin consumes.
 * @param {object} ctx - the plugin context.
 * @returns {object} service handles (absent members stay undefined).
 */
export function servicesOf(ctx) {
  return {
    sessionQuery: ctx.get('sessionQuery'),
    sessionPersistence: ctx.get('sessionPersistence'),
    attachments: ctx.get('attachments'),
    sessions: ctx.get('sessions'),
    agents: ctx.get('agents'),
    storageDomain: ctx.get('storageDomain'),
    workspaceRegistry: ctx.get('workspaceRegistry'),
    workingDirectory: ctx.get('workingDirectory'),
    agentPresets: ctx.get('agentPresets'),
  };
}

/** Both spellings one session id appears in: `session-<uuid>` and the raw uuid. */
function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId]);
  const tail = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  if (sessionId.startsWith('session-')) {
    if (tail !== '') variants.add(tail);
  } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId)) {
    variants.add(`session-${sessionId}`);
  }
  return [...variants];
}

/** Whether two ids name the same session, across both spellings. */
function sameSession(left, right) {
  const set = new Set(sessionIdVariants(left));
  return sessionIdVariants(right).some((variant) => set.has(variant));
}

/** Public spelling-tolerant id comparison for callers outside this module. */
export function sameSessionId(left, right) {
  return sameSession(left, right);
}

/**
 * The live session for an id, or undefined. Enumerates `sessions.list()`
 * instead of `sessions.get()`: the store is keyed by the canonical spelling,
 * and a caller holding the other spelling would get a silent miss.
 */
function liveSessionFor(ctx, id) {
  const sessions = servicesOf(ctx).sessions;
  if (sessions === undefined || typeof sessions.list !== 'function') return undefined;
  try {
    for (const session of sessions.list() ?? []) {
      if (session !== null && typeof session === 'object' && typeof session.id === 'string' && sameSession(session.id, id)) {
        return session;
      }
    }
  } catch {
    // An unreadable store reads as "not live"; removal proceeds cold.
  }
  return undefined;
}

/** The live agent owning a session, found by enumerating the agent registry. */
function liveAgentFor(ctx, id) {
  const agents = servicesOf(ctx).agents;
  if (agents === undefined || typeof agents.list !== 'function') return undefined;
  try {
    for (const agent of agents.list() ?? []) {
      if (agent === null || typeof agent !== 'object') continue;
      const candidates = [agent.id, agent.session?.id];
      if (candidates.some((candidate) => typeof candidate === 'string' && sameSession(candidate, id))) return agent;
    }
  } catch {
    // Same tolerance as above.
  }
  return undefined;
}

/** One registered entry of a store-like service, matched across id spellings. */
function storeEntryOf(service, id) {
  const store = service?.store;
  if (!(store instanceof Map)) return undefined;
  for (const [, entry] of store) {
    const entryId = entry !== null && typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : undefined;
    if (entryId !== undefined && sameSession(entryId, id)) return entry;
  }
  return undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop and release a live session so its log can be removed without a Host
 * restart: cancel the owning agent (bounded wait), flush a durability
 * checkpoint, then detach the session and agent entries from their registries.
 * Detaching emits `session/disposed`, which drains and closes the persistence
 * write handle; the caller waits for that before touching files.
 * @returns {Promise<boolean>} whether the live entries were detached.
 */
async function neutralizeLiveSession(ctx, id) {
  const agent = liveAgentFor(ctx, id);
  if (agent !== undefined) {
    try {
      agent.cancel?.({ kind: 'user' });
    } catch {
      // Already settling.
    }
    if (typeof agent.whenIdle === 'function') {
      await Promise.race([
        Promise.resolve(agent.whenIdle()).catch(() => undefined),
        new Promise((resolve) => {
          setTimeout(resolve, 15000);
        }),
      ]);
    }
  }

  const { sessions, agents } = servicesOf(ctx);
  const session = liveSessionFor(ctx, id);
  let detached = false;
  if (session !== undefined && sessions !== undefined) {
    try {
      await sessions.flush(session);
    } catch {
      // Removal proceeds; the flush is a checkpoint, not a gate.
    }
    const entry = storeEntryOf(sessions, id);
    try {
      if (entry !== undefined && typeof entry.detach === 'function') {
        entry.detach();
        detached = true;
      } else if (entry !== undefined && typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry);
        detached = true;
      }
    } catch {
      // A refused detach leaves the session live; the caller falls back to queuing.
    }
  }
  const agentEntry = agents === undefined ? undefined : storeEntryOf(agents, id);
  try {
    if (agentEntry !== undefined && typeof agents.detachEntered === 'function') {
      agents.detachEntered(agentEntry);
    } else if (agentEntry !== undefined && typeof agentEntry.detach === 'function') {
      agentEntry.detach();
    }
  } catch {
    // The session detach already removed it from every live list.
  }
  if (detached) {
    // `session/disposed` listeners drain and close the writer asynchronously.
    for (let attempt = 0; attempt < 40 && liveSessionFor(ctx, id) !== undefined; attempt += 1) await sleep(25);
    await sleep(150);
  }
  return detached;
}

/** Tell every connected client the session is gone (each id spelling once). */
function publishRemoved(ctx, id) {
  if (typeof ctx.emit !== 'function') return;
  for (const variant of sessionIdVariants(id)) {
    try {
      ctx.emit.call(ctx, 'api-session/removed', variant);
    } catch {
      // The UI refreshes on reconnect; the removal itself stands.
    }
  }
}

/**
 * The session format version this Harness writes.
 *
 * A running Harness has at least one stored session header in every practical
 * case; deriving the version from them keeps imports working across a format
 * upgrade without this plugin importing a DSH package. The configured value and
 * the compiled-in fallback only answer a truly empty store.
 * @param {object} ctx - the plugin context.
 * @param {number | undefined} configured - configured override.
 * @returns {Promise<number>} the format version to require of imported logs.
 */
export async function detectFormatVersion(ctx, configured) {
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  const query = ctx.get('sessionQuery');
  try {
    const records = await query.listSessions();
    if (Array.isArray(records) && records.length > 0) {
      const versions = records
        .map((record) => (record !== null && typeof record === 'object' ? record.header?.version : undefined))
        .filter((version) => Number.isSafeInteger(version) && version >= 0);
      if (versions.length > 0) return Math.max(...versions);
    }
  } catch {
    // An unreadable corpus falls back to the compiled-in version; the import
    // itself will still be validated against the real persistence backend.
  }
  return FALLBACK_SESSION_FORMAT_VERSION;
}

/** Fold the latest log-backed title out of one event list. */
function foldTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== null && typeof event === 'object' && event.type === TITLE_EVENT) {
      const title = event.data?.title;
      if (typeof title === 'string' && title.trim() !== '') return title.trim();
    }
  }
  return undefined;
}

/**
 * Read the latest log-backed title through the query service, falling back to
 * the log itself.
 *
 * `sessionQuery.readTitle()` resolves the folded title *string* directly (it
 * unwraps the snapshot); older drafts of this module read `.title` off it and
 * therefore silently lost every title the event fold did not find.
 */
async function readTitle(query, sessionId, events, signal) {
  const folded = foldTitle(events);
  if (folded !== undefined) return folded;
  try {
    const title = await query.readTitle(sessionId, signal);
    if (typeof title === 'string' && title.trim() !== '') return title.trim();
  } catch {
    // Title folding is cosmetic: an unreadable title must not fail the export.
  }
  return undefined;
}

/** Build the download file name for one exported session. */
function archiveFileName(title, sessionId) {
  const label = sanitizeFileName(title ?? sessionId, sessionId);
  return `${label}-${sessionId}.zip`;
}

/**
 * Read every subagent descendant of one session, in lineage order, so the
 * archive carries the complete conversation tree the way DSH's own session-log
 * export does (`subagents/<id>/session.vN.jsonl`).
 *
 * Each descendant is flushed while live and read through the query service's
 * validated view. A descendant that cannot be read becomes a warning instead of
 * failing the whole export: a backup missing one branch is better than none.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the root session id.
 * @param {{signal?: AbortSignal}} [options] - cancellation.
 * @returns {Promise<{logs: Array<{id: string, header: object, events: Array<object>}>, warnings: string[]}>} descendant logs.
 */
async function collectDescendantLogs(ctx, sessionId, { signal } = {}) {
  const { sessionQuery, sessions } = servicesOf(ctx);
  const logs = [];
  const warnings = [];
  if (sessionQuery === undefined) return { logs, warnings };
  if (typeof sessionQuery.traceSession !== 'function') {
    return { logs, warnings: ['会话查询服务不支持血缘追踪，子会话未包含在导出中'] };
  }
  let lineage;
  try {
    lineage = await sessionQuery.traceSession(sessionId, signal);
  } catch (error) {
    return { logs, warnings: [`子会话血缘读取失败：${errorText(error)}`] };
  }
  const seen = new Set([sessionId]);
  const walk = async (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      signal?.throwIfAborted();
      const id = node?.session?.header?.id ?? node?.session?.id;
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
      seen.add(id);
      const live = sessions?.get(id);
      if (live !== undefined) {
        try {
          await sessions.flush(live);
        } catch {
          // A stale live child still has its committed log; the read below decides.
        }
      }
      try {
        const snapshot = await sessionQuery.readSession(id);
        if (snapshot?.session === undefined || snapshot.session === null) throw new Error('没有存储头信息');
        logs.push({
          id,
          header: snapshot.session,
          events: Array.isArray(snapshot.events) ? snapshot.events : [],
        });
      } catch (error) {
        warnings.push(`子会话 ${id} 读取失败，未包含在导出中：${errorText(error)}`);
        continue;
      }
      await walk(node.descendants);
    }
  };
  await walk(lineage?.descendants);
  return { logs, warnings };
}

/**
 * Open one session export: resolve the session, its title, the archive file
 * name, the warnings known before any byte is written, and the attachment plan;
 * return a writer that streams the archive to a sink.
 *
 * Splitting "open" from "write" lets the browser route send its headers
 * (download name, pre-stream warnings, event count) before the first archive
 * byte, while the bytes themselves are produced one entry at a time and never
 * buffered whole. Every warning the plan can know is in `warnings` by the time
 * this resolves; the plan's `signal` cancels both the write and any streamed
 * attachment it opened. [`exportSession`] is the buffered convenience wrapper
 * for callers that want the complete file in memory.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - export request.
 * @param {string} options.sessionId - the session to export.
 * @param {'zip' | 'jsonl'} [options.format] - archive or bare JSONL.
 * @param {boolean} [options.includeAttachments] - pack referenced attachment bytes.
 * @param {boolean} [options.includeDescendants] - pack every subagent descendant log.
 * @param {AbortSignal} [options.signal] - cancellation, observed by `writeTo`.
 * @returns {Promise<{filename: string, header: object, eventCount: number, subagentCount: number, warnings: string[], writeTo: (sink: (chunk: Buffer) => void | Promise<void>) => Promise<{attachmentCount: number, entryCount: number}>}>} the export plan.
 */
export async function openSessionExport(
  ctx,
  { sessionId, format = 'zip', includeAttachments = true, includeDescendants = true, signal },
) {
  const handleId = String(sessionId ?? '').trim();
  if (handleId === '') throw new SessionPortFormatError('missing-session', '缺少要导出的会话 id');
  const { sessionQuery, sessions } = servicesOf(ctx);
  if (sessionQuery === undefined) throw new SessionPortFormatError('unavailable', '会话查询服务不可用，无法导出');

  // A live session keeps its newest events in memory; the flush barrier makes
  // the exact current log durable before the read.
  const live = sessions?.get(handleId);
  if (live !== undefined) {
    try {
      await sessions.flush(live);
    } catch (error) {
      throw new SessionPortFormatError('flush-failed', `会话的最新内容尚未写入存储：${errorText(error)}`);
    }
  }

  let snapshot;
  try {
    snapshot = await sessionQuery.readSession(handleId);
  } catch (error) {
    throw new SessionPortFormatError('not-found', `读取会话 ${handleId} 失败：${errorText(error)}`);
  }
  const header = snapshot.session;
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  if (header === undefined || header === null) throw new SessionPortFormatError('not-found', `会话 ${handleId} 没有存储头信息`);

  const logText = serializeSessionLog(header, events);
  const title = await readTitle(sessionQuery, handleId, events, signal);
  if (format === 'jsonl') {
    const warnings = includeAttachments ? ['JSONL 导出不包含附件与子会话；需要完整备份请使用 ZIP 格式'] : [];
    return {
      filename: `${sanitizeFileName(title ?? handleId, handleId)}-${handleId}.jsonl`,
      header,
      eventCount: events.length,
      subagentCount: 0,
      warnings,
      writeTo: async (sink) => {
        await sink(Buffer.from(logText, 'utf8'));
        return { attachmentCount: 0, entryCount: 1 };
      },
    };
  }

  const warnings = [];
  const descendantLogs = [];
  const descendantEntries = [];
  if (includeDescendants) {
    const gathered = await collectDescendantLogs(ctx, handleId, { signal });
    warnings.push(...gathered.warnings);
    for (const log of gathered.logs) {
      descendantLogs.push(log);
      descendantEntries.push({
        name: subagentLogEntryName(log.id, log.header.version),
        data: Buffer.from(serializeSessionLog(log.header, log.events), 'utf8'),
      });
    }
  }
  let attachmentEntries = [];
  if (includeAttachments) {
    const refs = collectAttachmentRefs(events);
    for (const log of descendantLogs) {
      const extra = collectAttachmentRefs(log.events);
      for (const [id, ref] of extra.images) if (!refs.images.has(id)) refs.images.set(id, ref);
      for (const [key, ref] of extra.files) if (!refs.files.has(key)) refs.files.set(key, ref);
    }
    const plan = await planAttachmentEntries(servicesOf(ctx).attachments, refs, signal);
    attachmentEntries = plan.entries;
    warnings.push(...plan.warnings);
  }
  const attachmentStats = { count: 0 };
  const logEntry = { name: sessionLogFileName(header.version), data: Buffer.from(logText, 'utf8') };
  return {
    filename: archiveFileName(title, handleId),
    header,
    eventCount: events.length,
    subagentCount: descendantEntries.length,
    warnings,
    writeTo: async (sink) => {
      throwIfAborted(signal);
      const archiveEntries = async function* archiveEntries() {
        yield logEntry;
        for (const entry of descendantEntries) yield entry;
        if (includeAttachments) {
          yield* iteratePlannedEntries(attachmentEntries, warnings, attachmentStats, signal);
        }
      };
      const written = await streamZipEntries(archiveEntries(), sink, { signal });
      return { attachmentCount: attachmentStats.count, entryCount: written.entryCount };
    },
  };
}

/**
 * Export one session as DSH's canonical session-log archive, fully buffered.
 * @param {object} ctx - the plugin context.
 * @param {object} options - see [`openSessionExport`].
 * @returns {Promise<{filename: string, data: Buffer, header: object, eventCount: number, attachmentCount: number, subagentCount: number, warnings: string[]}>} the produced file.
 */
export async function exportSession(ctx, options) {
  const plan = await openSessionExport(ctx, options);
  const chunks = [];
  const written = await plan.writeTo(async (chunk) => {
    chunks.push(chunk);
  });
  return {
    filename: plan.filename,
    data: Buffer.concat(chunks),
    header: plan.header,
    eventCount: plan.eventCount,
    attachmentCount: written.attachmentCount,
    subagentCount: plan.subagentCount,
    warnings: plan.warnings,
  };
}

/** True when an absolute path names an existing directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Choose the working directory the imported session records.
 * @param {object} ctx - the plugin context.
 * @param {{requestedCwd?: string, sourceCwd?: string}} request - caller-provided and archive-recorded candidates.
 * @returns {Promise<string>} an absolute existing directory.
 */
async function resolveTargetDirectory(ctx, { requestedCwd, sourceCwd }) {
  if (typeof requestedCwd === 'string' && isAbsolute(requestedCwd) && (await isDirectory(requestedCwd))) {
    return requestedCwd;
  }
  if (typeof sourceCwd === 'string' && isAbsolute(sourceCwd) && (await isDirectory(sourceCwd))) {
    return sourceCwd;
  }
  const fallback = servicesOf(ctx).workingDirectory?.defaultDirectory;
  if (typeof fallback === 'string' && fallback !== '' && (await isDirectory(fallback))) return fallback;
  return process.cwd();
}

/** Keep an imported agent preset only when this Harness still knows it. */
async function resolveAgentPreset(ctx, requested) {
  if (typeof requested !== 'string' || requested.trim() === '') return undefined;
  const presets = servicesOf(ctx).agentPresets;
  if (presets === undefined || typeof presets.resolve !== 'function') return undefined;
  try {
    const preset = await presets.resolve(requested);
    const id = preset?.id;
    return typeof id === 'string' && id !== '' ? id : requested;
  } catch {
    return undefined;
  }
}

/** Mint an unused session id in the store's own spelling. */
async function mintSessionId(persistence) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `session-${randomUUID()}`;
    try {
      const existing = await persistence.stat(id);
      if (existing === undefined) return id;
    } catch {
      return id;
    }
  }
  throw new SessionPortFormatError('id-failed', '无法生成唯一的会话 id，请重试');
}

/**
 * Add the imported session to the workspace whose directory it records, so the
 * sidebar shows it immediately. Attachment to a workspace is a convenience: a
 * session without one still lists under the ungrouped account. A failure here
 * must not fail the import, but it must reach the caller's warnings — silently
 * dropping the attachment makes the import look like it landed where it did not.
 * @param {object} ctx - the plugin context.
 * @param {{sessionId: string, workspaceId?: string, cwd: string}} target - session and preferred workspace.
 * @returns {Promise<{workspaceId?: string, warning?: string}>} the workspace it joined, or why it did not.
 */
async function attachToWorkspace(ctx, { sessionId, workspaceId, cwd }) {
  const registry = servicesOf(ctx).workspaceRegistry;
  if (registry === undefined) return {};
  const requested = typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : undefined;
  let workspace;
  let fellBack = false;
  if (requested !== undefined) {
    workspace = registry.get(requested);
    fellBack = workspace === undefined;
  }
  if (workspace === undefined) {
    try {
      workspace = await registry.resolveByPath(cwd);
    } catch {
      workspace = undefined;
    }
  }
  if (workspace === undefined) {
    return requested === undefined
      ? {}
      : { warning: `找不到工作区 ${requested}，会话没有加入任何工作区` };
  }
  try {
    try {
      await workspace.attachSession(sessionId);
    } catch (error) {
      // The attach validates the stored cwd through a storage scan, which a
      // stale ghost of a just-deleted directory can trip over; one short retry
      // rides that out instead of leaving the import ungrouped.
      await sleep(400);
      await workspace.attachSession(sessionId);
    }
  } catch (error) {
    ctx.logger?.warn?.(
      `session-port: imported session could not join workspace ${String(workspace.id)}: ${errorText(error)}`,
    );
    return { warning: `会话已导入，但没能加入工作区 ${String(workspace.id)}：${errorText(error)}` };
  }
  const joinedId = String(workspace.id);
  if (fellBack && requested !== undefined) {
    return {
      workspaceId: joinedId,
      warning: `找不到请求的工作区 ${requested}，会话已加入工作区 ${joinedId}`,
    };
  }
  return { workspaceId: joinedId };
}

/**
 * Split one import buffer into its canonical log text and attachment entries.
 * @param {Buffer} buffer - the uploaded file.
 * @param {string} [filename] - original file name, used only in diagnostics.
 * @returns {Promise<{header: object, events: Array<object>, attachmentEntries: Array<{name: string, data: Uint8Array}>, warnings: string[]}>} parsed archive.
 */
async function parseImportBuffer(buffer, filename) {
  if (isZipBuffer(buffer)) {
    let entries;
    try {
      // PowerShell 5.1 `Compress-Archive` writes directory separators as `\`;
      // normalize them so those archives import as well as fflate/PS7 ones.
      entries = readZipEntries(buffer).map((entry) => ({
        name: entry.name.replaceAll('\\', '/'),
        data: entry.data,
      }));
    } catch (error) {
      throw new SessionPortFormatError('invalid-zip', `ZIP 文件无法解析：${errorText(error)}`);
    }
    const rootName = findRootLogEntry(entries);
    if (rootName === undefined) {
      const top = entries.filter((entry) => !entry.name.includes('/')).slice(0, 6).map((entry) => entry.name);
      throw new SessionPortFormatError(
        'no-log',
        `压缩包里没有找到会话日志（session.vN.jsonl）${top.length > 0 ? `；顶层文件：${top.join('、')}` : ''}`,
      );
    }
    const rootEntry = entries.find((entry) => entry.name === rootName);
    const text = Buffer.from(rootEntry.data).toString('utf8');
    const warnings = [];
    if (entries.some((entry) => entry.name.startsWith('subagents/'))) {
      warnings.push('压缩包包含子会话（subagents/），导入只恢复主会话');
    }
    const parsed = parseSessionLog(stripBom(text));
    const attachmentEntries = entries.filter(
      (entry) => entry.name.startsWith('media/') || entry.name.startsWith('files/'),
    );
    return { ...parsed, attachmentEntries, warnings };
  }

  // A bare JSONL file is accepted with or without events: a session that never
  // ran still exports as a single header line.
  const text = stripBom(buffer.toString('utf8'));
  const parsed = parseSessionLog(text);
  return { ...parsed, attachmentEntries: [], warnings: [] };
}

/** Drop a UTF-8 BOM left by Windows editors. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Import one session archive as a new persisted session.
 * @param {object} ctx - the plugin context.
 * @param {object} options - import request.
 * @param {Buffer} options.buffer - uploaded archive bytes.
 * @param {string} [options.filename] - original file name for diagnostics.
 * @param {string} [options.cwd] - requested working directory.
 * @param {string} [options.workspaceId] - preferred workspace to join.
 * @param {number} [options.configuredFormatVersion] - configured format override.
 * @param {number} [options.maxImportBytes] - request size cap.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{sessionId: string, title?: string, eventCount: number, attachmentCount: number, workspaceId?: string, warnings: string[]}>} the created session.
 */
export async function importSession(ctx, options) {
  const {
    buffer,
    filename,
    cwd,
    workspaceId,
    configuredFormatVersion,
    maxImportBytes = DEFAULT_MAX_IMPORT_BYTES,
    signal,
  } = options;
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) {
    throw new SessionPortFormatError('empty-file', '导入文件是空的');
  }
  if (buffer.length > maxImportBytes) {
    throw new SessionPortFormatError('too-large', `导入文件超过大小上限（${Math.round(maxImportBytes / 1024 / 1024)} MiB）`);
  }
  const parsed = await parseImportBuffer(Buffer.from(buffer), filename);
  const warnings = [...parsed.warnings];

  const currentVersion = await detectFormatVersion(ctx, configuredFormatVersion);
  if (parsed.header.version !== currentVersion) {
    throw new SessionPortFormatError(
      'format-version',
      `该会话是格式 v${String(parsed.header.version)}，当前 DSH 使用 v${currentVersion}；请先用对应版本的 DSH 打开并重新导出`,
    );
  }
  validateEvents(parsed.events);

  const persistence = servicesOf(ctx).sessionPersistence;
  if (persistence === undefined) throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法导入');

  const targetCwd = await resolveTargetDirectory(ctx, { requestedCwd: cwd, sourceCwd: parsed.header.cwd });
  const newId = await mintSessionId(persistence);
  const agentPreset = await resolveAgentPreset(ctx, parsed.header.agentPreset);

  const header = {
    version: currentVersion,
    id: newId,
    createdAt: parsed.header.createdAt,
    cwd: targetCwd,
    isSeeded: false,
    ...(agentPreset !== undefined ? { agentPreset } : {}),
  };

  // Create the Session before touching the attachment store: restoring an
  // archive's attachment bytes first would leave unreachable attachment objects
  // behind whenever session creation fails (the bytes are addressed by content,
  // but nothing in any session log would reference them any more).
  let handle;
  try {
    handle = await persistence.create(header);
  } catch (error) {
    throw new SessionPortFormatError('create-failed', `创建会话失败：${errorText(error)}`);
  }

  let replacements = new Map();
  let events;
  try {
    if (parsed.attachmentEntries.length > 0) {
      const restored = await restoreAttachmentEntries(servicesOf(ctx).attachments, parsed.attachmentEntries, signal);
      replacements = restored.replacements;
      warnings.push(...restored.warnings);
    }
    const withAttachments = replacements.size > 0 ? rewriteAttachmentRefs(parsed.events, replacements) : parsed.events;
    // The log was produced by another Session: its delivery markers name the
    // source id, and the current-format reader refuses a log whose marker names a
    // different Session. Re-point them at the new owner before writing.
    const owned = rewriteDeliveryIdentity(withAttachments, newId, currentVersion);
    // A forked (seeded) log also carries its parent's history behind an
    // `inherited` end-seed marker; the new Session is unseeded, and the reader
    // refuses that combination, so the flag is dropped while the history stays.
    events = rewriteSeedMarkers(owned);
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error;
  }
  try {
    if (events.length > 0) await handle.append(events);
    await handle.flush();
  } catch (error) {
    throw new SessionPortFormatError('write-failed', `写入会话内容失败：${errorText(error)}`);
  } finally {
    await handle.close();
  }

  const joined = await attachToWorkspace(ctx, { sessionId: newId, workspaceId, cwd: targetCwd });
  if (joined.warning !== undefined) warnings.push(joined.warning);
  const importedTitle = foldTitle(events);
  registerUndoableImport(ctx, newId, {
    ...(joined.workspaceId !== undefined ? { workspaceId: joined.workspaceId } : {}),
    importedAt: Date.now(),
    ...(importedTitle !== undefined ? { title: importedTitle } : {}),
    eventCount: events.length,
  });
  // Prove the new Session re-opens. The log came from another Session, so an
  // archive the current reader refuses must fail loudly here instead of looking
  // imported and then refusing to load when the user clicks it.
  const reopened = await verifyImportedSession(ctx, newId);
  if (!reopened.ok && reopened.detail !== undefined) {
    warnings.push(`会话已写入，但当前 DSH 无法重新打开它：${reopened.detail}`);
  }
  return {
    sessionId: newId,
    title: importedTitle,
    eventCount: events.length,
    attachmentCount: replacements.size,
    verified: reopened.ok,
    ...(joined.workspaceId !== undefined ? { workspaceId: joined.workspaceId } : {}),
    warnings,
  };
}

/**
 * Undo one import this plugin process made. A running (live) session is not an
 * error: the undo is queued on its record and completes automatically when the
 * session is disposed (see {@link watchPendingUndos}).
 * @param {object} ctx - the plugin context.
 * @param {object} options - undo request.
 * @param {string} options.sessionId - the session an import returned.
 * @param {string} [options.projectionCacheDirectory] - cache root override (tests).
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{sessionId: string, deferred?: boolean, warnings: string[]}>} the undone (or queued) session.
 */
export async function undoImportedSession(ctx, { sessionId, projectionCacheDirectory, signal }) {
  const id = String(sessionId ?? '').trim();
  if (id === '') throw new SessionPortFormatError('missing-session', '缺少要撤销的会话 id');
  const record = undoablesOf(ctx).get(id);
  if (record === undefined) {
    throw new SessionPortFormatError(
      'not-imported',
      '该会话不是本插件导入的（注册表中没有记录），不能撤销；请在会话列表中手动处理',
    );
  }
  const { sessionPersistence } = servicesOf(ctx);
  if (sessionPersistence === undefined) throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法撤销');
  signal?.throwIfAborted();

  const warnings = [];
  if (liveSessionFor(ctx, id) !== undefined || liveAgentFor(ctx, id) !== undefined) {
    const released = await neutralizeLiveSession(ctx, id);
    if (liveSessionFor(ctx, id) !== undefined) {
      // The entry could not be released; queue on the record and complete via
      // the disposal watch or the startup sweep.
      record.pendingUndo = true;
      persistUndoables(ctx);
      return {
        sessionId: id,
        deferred: true,
        warnings: ['该会话正在运行且无法立即释放；已登记撤销，它被关闭后将自动完成删除'],
      };
    }
    warnings.push(released ? '已停止并释放运行中的会话，然后删除' : '会话已不再运行，直接删除');
  }
  const removed = await removeImportedSession(ctx, id, { projectionCacheDirectory, signal });
  publishRemoved(ctx, id);
  return { ...removed, deferred: false, warnings: [...warnings, ...removed.warnings] };
}

/**
 * Remove one registered import: detach it from the workspace it joined, remove
 * its stored session directory, and drop the projection-cache entry. Attachment
 * objects deliberately stay behind — they are content-addressed and may be
 * shared with other sessions. The storage path is resolved through the
 * persistence service itself and the directory name is checked against the
 * session id before anything is deleted.
 */
async function removeImportedSession(ctx, id, { projectionCacheDirectory, signal }) {
  const { sessionPersistence, workspaceRegistry } = servicesOf(ctx);
  const record = undoablesOf(ctx).get(id);
  signal?.throwIfAborted();

  const warnings = [];
  if (record?.workspaceId !== undefined && workspaceRegistry !== undefined) {
    try {
      const workspace = workspaceRegistry.get(record.workspaceId);
      if (workspace !== undefined) await workspace.detachSession(id);
    } catch (error) {
      warnings.push(`会话已删除，但从工作区 ${String(record.workspaceId)} 的成员表摘除失败：${errorText(error)}`);
    }
  }

  let location;
  try {
    location = await sessionPersistence.stat(id);
  } catch {
    location = undefined;
  }
  if (location !== null && typeof location === 'object' && typeof location.path === 'string' && location.path !== '') {
    const directory = dirname(location.path);
    if (basename(directory) !== id) {
      throw new SessionPortFormatError(
        'undo-failed',
        '存储目录与会话 id 不符；为安全起见未删除任何内容',
      );
    }
    // A just-closed writer may hold the directory for a few turns; retry.
    let directoryGone = false;
    for (let attempt = 0; attempt < 10 && !directoryGone; attempt += 1) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      try {
        await stat(directory);
      } catch {
        directoryGone = true;
      }
      if (!directoryGone) await sleep(150);
    }
    if (!directoryGone) {
      // Keep the registry entry: the session is still on disk and must stay
      // undoable instead of becoming an orphan no history row can remove.
      throw new SessionPortFormatError(
        'undo-failed',
        '会话目录暂时无法删除（可能被占用）；记录已保留，请稍后重试撤销',
      );
    }
  } else {
    warnings.push('该会话在存储中已不存在，仅清理了成员记录');
  }

  await dropProjectionDomainRow(ctx, id);
  await removeProjectionFiles(id, projectionCacheDirectory ?? defaultProjectionCacheDirectory());

  undoablesOf(ctx).delete(id);
  persistUndoables(ctx);
  return { sessionId: id, warnings };
}

/** Delete the session's projection-cache row through the live storage domain. */
async function dropProjectionDomainRow(ctx, id) {
  const domains = servicesOf(ctx).storageDomain;
  const cache = typeof domains?.get === 'function' ? domains.get('session_projcache') : undefined;
  if (cache === undefined || typeof cache.table !== 'function') return false;
  try {
    const table = cache.table('sessions');
    for (const variant of sessionIdVariants(id)) await table.delete(variant);
    return true;
  } catch {
    return false;
  }
}

/** Remove the session's on-disk projection-cache documents, both id spellings. */
async function removeProjectionFiles(id, cacheRoot) {
  const directory = join(cacheRoot, 'sessions');
  let names = [];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  const variants = sessionIdVariants(id);
  let removed = 0;
  for (const name of names) {
    const matches = variants.some(
      (variant) => name === `${variant}.json` || name.startsWith(`${variant}.json.bak.`),
    );
    if (!matches) continue;
    try {
      await rm(join(directory, name), { force: true });
      removed += 1;
    } catch {
      // Held open or already gone; the domain row is the authority.
    }
  }
  return removed;
}

/**
 * Watch session disposals and complete queued undos, and sweep once at
 * registration: after a Host restart every session is cold, so any queued
 * undo left over from the previous run completes right away. Register once
 * from the plugin's apply through an effect; the returned disposer stops the
 * watch (the sweep runs regardless).
 * @param {object} ctx - the plugin context.
 * @returns {() => void} disposer.
 */
export function watchPendingUndos(ctx) {
  void sweepPendingUndos(ctx).catch((error) => {
    console.warn('session-port: pending-undo sweep failed:', error);
  });
  if (typeof ctx.on !== 'function') return () => {};
  const dispose = ctx.on('session/disposed', (session) => {
    const id = session?.id;
    if (typeof id !== 'string' || id === '') return;
    const record = undoablesOf(ctx).get(id);
    if (record === undefined || record.pendingUndo !== true) return;
    void removeImportedSession(ctx, id, {}).catch((error) => {
      console.warn(`session-port: deferred undo of ${id} failed:`, error);
    });
  });
  return typeof dispose === 'function' ? dispose : () => {};
}

/** Complete every queued undo whose session is no longer running. */
async function sweepPendingUndos(ctx) {
  for (const [id, record] of undoablesOf(ctx)) {
    if (record.pendingUndo !== true) continue;
    if (servicesOf(ctx).sessions?.get(id) !== undefined) continue;
    try {
      await removeImportedSession(ctx, id, {});
    } catch (error) {
      console.warn(`session-port: deferred undo of ${id} failed:`, error);
    }
  }
}

/**
 * Re-open one freshly written session through the query service, which replays
 * and validates the stored log exactly as opening it in the UI does.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the session just created.
 * @returns {Promise<{ok: boolean, detail?: string, skipped?: boolean}>} verification result.
 */
async function verifyImportedSession(ctx, sessionId) {
  const { sessionQuery } = servicesOf(ctx);
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
    return { ok: true, skipped: true };
  }
  try {
    const snapshot = await sessionQuery.readSession(sessionId);
    if (snapshot?.session === undefined || snapshot.session === null) {
      return { ok: false, detail: '读回的会话没有存储头信息' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}

/**
 * Read one import file from the host filesystem (agent-tool path).
 * @param {string} path - file path.
 * @param {{cwd?: string, maxImportBytes?: number}} options - resolution base and cap.
 * @returns {Promise<{buffer: Buffer, filename: string, resolved: string}>} file bytes.
 */
export async function readImportFile(path, { cwd, maxImportBytes = DEFAULT_MAX_IMPORT_BYTES }) {
  const resolved = isAbsolute(path) ? path : resolvePath(cwd ?? process.cwd(), path);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new SessionPortFormatError('file-missing', `找不到文件 ${resolved}：${errorText(error)}`);
  }
  if (!info.isFile()) throw new SessionPortFormatError('file-missing', `${resolved} 不是文件`);
  if (info.size > maxImportBytes) {
    throw new SessionPortFormatError('too-large', `导入文件超过大小上限（${Math.round(maxImportBytes / 1024 / 1024)} MiB）`);
  }
  const buffer = await readFile(resolved);
  return { buffer, filename: resolved.split(/[\\/]/u).pop() ?? resolved, resolved };
}

/**
 * Write one export archive under a plugin-owned directory (agent-tool path).
 *
 * The archive is streamed straight to disk entry by entry: a large attachment is
 * read as a stream into the ZIP writer, so its bytes are never copied through a
 * full in-memory archive. A partially written file is removed when the write
 * fails, so the directory never keeps a corrupt backup under a valid name.
 *
 * The destination stream keeps an `error` listener for its whole lifetime: a
 * disk failure must fail this export, not surface as an uncaught `error` event
 * that takes the Host process down between two writes.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - export request plus output options.
 * @param {string} [options.directory] - output directory override.
 * @param {AbortSignal} [options.signal] - cancellation (also closes the file).
 * @returns {Promise<{path: string, filename: string, eventCount: number, attachmentCount: number, subagentCount: number, warnings: string[]}>} written file.
 */
export async function writeExportFile(ctx, options) {
  const directory = options.directory ?? defaultExportDirectory();
  const { signal } = options;
  const plan = await openSessionExport(ctx, options);
  await mkdir(directory, { recursive: true });
  const path = join(directory, plan.filename);
  const stream = createWriteStream(path);
  /** @type {Error | undefined} */
  let streamFailure;
  stream.on('error', (error) => {
    streamFailure ??= error;
  });
  try {
    const written = await plan.writeTo(async (chunk) => {
      throwIfAborted(signal);
      if (streamFailure !== undefined) throw streamFailure;
      if (stream.write(chunk)) return;
      await waitForDrain(stream, signal);
    });
    stream.end();
    await finished(stream);
    return {
      path,
      filename: plan.filename,
      eventCount: plan.eventCount,
      attachmentCount: written.attachmentCount,
      subagentCount: plan.subagentCount,
      warnings: plan.warnings,
    };
  } catch (error) {
    stream.destroy();
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

/** The plugin-owned export directory used when the caller names none. */
export function defaultExportDirectory() {
  const home = process.env.DSH_HOME;
  const root = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh');
  return join(root, 'session-port', 'exports');
}

/** Where this Harness keeps per-session projection-cache files. */
function defaultProjectionCacheDirectory() {
  const home = process.env.DSH_HOME;
  const root = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh');
  return join(root, 'storages', 'session_projcache');
}

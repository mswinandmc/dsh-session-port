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
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { errorText, collectAttachmentEntries, restoreAttachmentEntries } from './attachments.js';
import {
  SessionPortFormatError,
  collectAttachmentRefs,
  findRootLogEntry,
  isZipBuffer,
  parseSessionLog,
  rewriteAttachmentRefs,
  rewriteDeliveryIdentity,
  sanitizeFileName,
  serializeSessionLog,
  sessionLogFileName,
  validateEvents,
} from './format.js';
import { readZipEntries, writeZipEntries } from './zip.js';

/** Format version assumed when no stored session can tell us the current one. */
export const FALLBACK_SESSION_FORMAT_VERSION = 4;
/** Upper bound on one import request body. */
export const DEFAULT_MAX_IMPORT_BYTES = 512 * 1024 * 1024;
/** Title event carried by the session log itself. */
const TITLE_EVENT = 'session/title';

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
    workspaceRegistry: ctx.get('workspaceRegistry'),
    workingDirectory: ctx.get('workingDirectory'),
    agentPresets: ctx.get('agentPresets'),
  };
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

/** Read the latest log-backed title through the query service, falling back to the log itself. */
async function readTitle(query, sessionId, events, signal) {
  const folded = foldTitle(events);
  if (folded !== undefined) return folded;
  try {
    const snapshot = await query.readTitle(sessionId, signal);
    const title = snapshot?.title;
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
 * Export one session as DSH's canonical session-log archive.
 * @param {object} ctx - the plugin context.
 * @param {object} options - export request.
 * @param {string} options.sessionId - the session to export.
 * @param {'zip' | 'jsonl'} [options.format] - archive or bare JSONL.
 * @param {boolean} [options.includeAttachments] - pack referenced attachment bytes.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{filename: string, data: Buffer, header: object, eventCount: number, attachmentCount: number, warnings: string[]}>} the produced file.
 */
export async function exportSession(ctx, { sessionId, format = 'zip', includeAttachments = true, signal }) {
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
    return {
      filename: `${sanitizeFileName(title ?? handleId, handleId)}-${handleId}.jsonl`,
      data: Buffer.from(logText, 'utf8'),
      header,
      eventCount: events.length,
      attachmentCount: 0,
      warnings: includeAttachments ? ['JSONL 导出不包含附件；需要完整备份请使用 ZIP 格式'] : [],
    };
  }

  const entries = [{ name: sessionLogFileName(header.version), data: Buffer.from(logText, 'utf8') }];
  const warnings = [];
  if (includeAttachments) {
    const refs = collectAttachmentRefs(events);
    const packed = await collectAttachmentEntries(servicesOf(ctx).attachments, refs, signal);
    entries.push(...packed.entries);
    warnings.push(...packed.warnings);
  }
  const data = writeZipEntries(entries);
  return {
    filename: archiveFileName(title, handleId),
    data,
    header,
    eventCount: events.length,
    attachmentCount: entries.length - 1,
    warnings,
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
 * sidebar shows it immediately. Attachment to a workspace is a convenience:
 * a session without one still lists under the ungrouped account.
 * @param {object} ctx - the plugin context.
 * @param {{sessionId: string, workspaceId?: string, cwd: string}} target - session and preferred workspace.
 * @returns {Promise<string | undefined>} the workspace id it joined, when any.
 */
async function attachToWorkspace(ctx, { sessionId, workspaceId, cwd }) {
  const registry = servicesOf(ctx).workspaceRegistry;
  if (registry === undefined) return undefined;
  let workspace;
  if (typeof workspaceId === 'string' && workspaceId !== '') workspace = registry.get(workspaceId);
  if (workspace === undefined) {
    try {
      workspace = await registry.resolveByPath(cwd);
    } catch {
      workspace = undefined;
    }
  }
  if (workspace === undefined) return undefined;
  try {
    await workspace.attachSession(sessionId);
    return workspace.id;
  } catch (error) {
    ctx.logger?.warn?.(`session-port: imported session could not join workspace ${String(workspace.id)}: ${errorText(error)}`);
    return undefined;
  }
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

  let replacements = new Map();
  if (parsed.attachmentEntries.length > 0) {
    const restored = await restoreAttachmentEntries(servicesOf(ctx).attachments, parsed.attachmentEntries, signal);
    replacements = restored.replacements;
    warnings.push(...restored.warnings);
  }
  const withAttachments = replacements.size > 0 ? rewriteAttachmentRefs(parsed.events, replacements) : parsed.events;
  // The log was produced by another Session: its delivery markers name the
  // source id, and the current-format reader refuses a log whose marker names a
  // different Session. Re-point them at the new owner before writing.
  const events = rewriteDeliveryIdentity(withAttachments, newId, currentVersion);

  const header = {
    version: currentVersion,
    id: newId,
    createdAt: parsed.header.createdAt,
    cwd: targetCwd,
    isSeeded: false,
    ...(agentPreset !== undefined ? { agentPreset } : {}),
  };

  let handle;
  try {
    handle = await persistence.create(header);
  } catch (error) {
    throw new SessionPortFormatError('create-failed', `创建会话失败：${errorText(error)}`);
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
  return {
    sessionId: newId,
    title: foldTitle(events),
    eventCount: events.length,
    attachmentCount: replacements.size,
    ...(joined !== undefined ? { workspaceId: String(joined) } : {}),
    warnings,
  };
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
 * @param {object} ctx - the plugin context.
 * @param {object} options - export request plus output options.
 * @param {string} [options.directory] - output directory override.
 * @returns {Promise<{path: string, filename: string, eventCount: number, attachmentCount: number, warnings: string[]}>} written file.
 */
export async function writeExportFile(ctx, options) {
  const directory = options.directory ?? defaultExportDirectory();
  const exported = await exportSession(ctx, options);
  await mkdir(directory, { recursive: true });
  const path = join(directory, exported.filename);
  await writeFile(path, exported.data);
  return {
    path,
    filename: exported.filename,
    eventCount: exported.eventCount,
    attachmentCount: exported.attachmentCount,
    warnings: exported.warnings,
  };
}

/** The plugin-owned export directory used when the caller names none. */
export function defaultExportDirectory() {
  const home = process.env.DSH_HOME;
  const root = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh');
  return join(root, 'session-port', 'exports');
}

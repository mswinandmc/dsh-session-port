/**
 * Session Port — pure session-log format helpers.
 *
 * The wire format is DSH's own canonical session-log JSONL, the same one the
 * shipped session-log export writes into its archive:
 *
 *   line 1 : {"type":"session", version, id, createdAt, cwd?, parentSession?,
 *             isSeeded, origin?, delegationDepth, agentPreset?}
 *   line 2n: one committed SessionEvent per line
 *
 * Details deliberately mirror `@deepseek-ai/dsh-session-log-export`
 * (`serializeSessionLog`) so an archive produced by either side can be read by
 * the other. Nothing here touches Cordis services: every export is a pure
 * function so it can be unit-tested without a Harness process.
 *
 * @module dsh-session-port/format
 */

/** Error carrying a stable code so callers can localize their own copy. */
export class SessionPortFormatError extends Error {
  /**
   * @param {string} code - stable machine-readable failure code.
   * @param {string} message - human-readable diagnostic.
   */
  constructor(code, message) {
    super(message);
    this.name = 'SessionPortFormatError';
    this.code = code;
  }
}

/** Image media types accepted by the attachment store, with their archive extension. */
const MEDIA_TYPE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Reverse map for archive reads; jpeg|jpg both accepted. */
const EXTENSION_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** The top-level canonical log name for one format version. */
export function sessionLogFileName(version) {
  return Number.isSafeInteger(version) && version > 0 ? `session.v${version}.jsonl` : 'session.jsonl';
}

/**
 * One filesystem-safe archive path segment from an untrusted session id, the
 * same spelling DSH's own exporter uses (`.` and separators cannot escape the
 * `subagents/` folder).
 * @param {string} id - raw session id.
 * @returns {string} a single safe segment.
 */
export function safeSessionIdSegment(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/gu, '_');
}

/**
 * Archive entry name for one subagent descendant's log: DSH's own layout, so an
 * archive produced here imports into other tools that read that archive shape.
 * @param {string} id - the descendant session id.
 * @param {number} version - that descendant's format version.
 * @returns {string} the entry name.
 */
export function subagentLogEntryName(id, version) {
  return `subagents/${safeSessionIdSegment(id)}/${sessionLogFileName(version)}`;
}

/** Normalize the header line the way the shipped exporter writes it. */
export function headerLineOf(header) {
  return {
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}),
    isSeeded: header.isSeeded === true,
    ...(header.origin !== undefined ? { origin: header.origin } : {}),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
  };
}

/**
 * Serialize one session's logical log as canonical JSONL text.
 * @param {object} header - immutable session header.
 * @param {ReadonlyArray<object>} events - validated committed events in seq order.
 * @returns {string} trailing-newline terminated JSONL text.
 */
export function serializeSessionLog(header, events) {
  const lines = [JSON.stringify(headerLineOf(header))];
  for (const event of events) lines.push(JSON.stringify(event));
  return `${lines.join('\n')}\n`;
}

/** Read the attachment ids an event log references, split into images and files. */
function walkAttachmentRefs(value, visit) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const member of value) walkAttachmentRefs(member, visit);
    return;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.attachmentId === 'string') {
    const mediaType = record.mediaType;
    const name = record.name;
    const bytes = record.bytes;
    if (
      typeof mediaType === 'string' &&
      MEDIA_TYPE_EXTENSIONS[mediaType] !== undefined &&
      typeof bytes === 'number' &&
      typeof record.width === 'number' &&
      typeof record.height === 'number'
    ) {
      visit('image', {
        attachmentId: record.attachmentId,
        mediaType,
        bytes,
        width: record.width,
        height: record.height,
        ...(typeof name === 'string' ? { name } : {}),
      });
    } else if (typeof name === 'string' && typeof bytes === 'number') {
      visit('file', { attachmentId: record.attachmentId, name, bytes });
    }
  }
  for (const member of Object.values(record)) walkAttachmentRefs(member, visit);
}

/**
 * Collect every distinct attachment reference one session log names.
 * @param {ReadonlyArray<object>} events - committed events.
 * @returns {{images: Map<string, object>, files: Map<string, object>}} deduped by attachment id.
 */
export function collectAttachmentRefs(events) {
  const images = new Map();
  const files = new Map();
  for (const event of events) {
    walkAttachmentRefs(event, (kind, ref) => {
      const target = kind === 'image' ? images : files;
      if (!target.has(ref.attachmentId)) target.set(ref.attachmentId, ref);
    });
  }
  return { images, files };
}

/**
 * Deep-clone events, replacing attachment references with the durable ones the
 * local attachment store produced. A reference whose id did not change keeps
 * every original field; a changed one adopts the stored ref's metadata so the
 * rewritten log stays self-consistent.
 * @param {ReadonlyArray<object>} events - imported events.
 * @param {Map<string, object>} replacements - original attachment id -> stored reference.
 * @returns {Array<object>} rewritten events (a fresh array; inputs untouched).
 */
export function rewriteAttachmentRefs(events, replacements) {
  const rewrite = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(rewrite);
    const record = /** @type {Record<string, unknown>} */ (value);
    if (typeof record.attachmentId === 'string') {
      const replacement = replacements.get(record.attachmentId);
      if (replacement !== undefined) {
        return {
          ...record,
          attachmentId: replacement.attachmentId,
          ...(replacement.name !== undefined ? { name: replacement.name } : {}),
          ...(replacement.bytes !== undefined ? { bytes: replacement.bytes } : {}),
          ...(replacement.mediaType !== undefined ? { mediaType: replacement.mediaType } : {}),
          ...(replacement.width !== undefined ? { width: replacement.width } : {}),
          ...(replacement.height !== undefined ? { height: replacement.height } : {}),
        };
      }
    }
    let next;
    for (const [key, member] of Object.entries(record)) {
      const rewritten = rewrite(member);
      if (rewritten === member) continue;
      if (next === undefined) next = { ...record };
      next[key] = rewritten;
    }
    return next ?? record;
  };
  return events.map(rewrite);
}

/** Event type recording one upstream session-log delivery watermark. */
const DELIVERY_EVENT = 'session-log-deepseek/delivery-accepted';

/**
 * Re-point the session-log delivery markers at the Session that now owns the
 * imported log.
 *
 * A `delivery-accepted` marker names the Session it was appended for, and the
 * current-format reader refuses a log whose active-generation marker names a
 * different Session ("current-generation delivery marker names the wrong
 * Session"). An archive was produced by another Session, so every marker it
 * carries names the source id; copying the log verbatim therefore creates a
 * Session that lists correctly but cannot be opened — the import reports
 * success and its history then fails to load. That is exactly the bug this
 * function fixes.
 *
 * Only markers of the generation being imported are rewritten: markers for
 * other format generations are ignored by the reader and keep their original
 * payload. Everything else in the log is preserved byte for byte.
 * @param {ReadonlyArray<object>} events - imported events.
 * @param {string} sessionId - the new Session id that owns the imported log.
 * @param {number} sessionFormatVersion - the format generation being imported.
 * @returns {Array<object>} rewritten events (the input array itself when nothing changed).
 */
export function rewriteDeliveryIdentity(events, sessionId, sessionFormatVersion) {
  let changed = false;
  const next = events.map((event) => {
    if (event === null || typeof event !== 'object' || event.type !== DELIVERY_EVENT) return event;
    const data = /** @type {Record<string, unknown>} */ (event.data);
    if (data === null || typeof data !== 'object') return event;
    const markerVersion = Number.isSafeInteger(data.sessionFormatVersion) ? data.sessionFormatVersion : 0;
    if (markerVersion !== sessionFormatVersion) return event;
    if (data.sessionId === sessionId) return event;
    changed = true;
    return { ...event, data: { ...data, sessionId } };
  });
  return changed ? next : events;
}

/** Event type marking where a seeded Session's inherited prefix ends. */
const SEED_END_EVENT = 'session/end-seed';

/**
 * Turn a seeded (forked) log into a standalone one by dropping the
 * "this prefix was inherited" flag.
 *
 * A fork's log starts with its parent's history and carries
 * `session/end-seed { inherited: true }` at the cut. An import always creates an
 * *unseeded* Session, and the current-format reader refuses that combination
 * outright ("unseeded Session contains an inherited end-seed marker"), which
 * makes a forked archive import "successfully" and then fail to open. The flag
 * is the only seeded-only fact the reader checks, so the marker is kept as a
 * plain lifecycle event (the same shape an unseeded snapshot ends with) and the
 * history stays byte-identical.
 *
 * @param {ReadonlyArray<object>} events - imported events.
 * @returns {Array<object>} rewritten events (the input array itself when nothing changed).
 */
export function rewriteSeedMarkers(events) {
  let changed = false;
  const next = events.map((event) => {
    if (event === null || typeof event !== 'object' || event.type !== SEED_END_EVENT) return event;
    const data = /** @type {Record<string, unknown>} */ (event.data);
    if (data === null || typeof data !== 'object' || data.inherited !== true) return event;
    changed = true;
    const { inherited: _inherited, ...rest } = data;
    return { ...event, data: rest };
  });
  return changed ? next : events;
}

/** True when the buffer starts with a local ZIP file header. */
export function isZipBuffer(buffer) {
  return (
    buffer !== undefined &&
    buffer !== null &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06)
  );
}

/**
 * Parse one canonical session-log JSONL text.
 * @param {string} text - JSONL text.
 * @returns {{header: object, events: Array<object>}} parsed header line (raw) and events.
 * @throws {SessionPortFormatError} when the text is not a session log.
 */
export function parseSessionLog(text) {
  const lines = text.split(/\r?\n/u);
  let header;
  const events = [];
  let lineNumber = 0;
  for (const raw of lines) {
    lineNumber += 1;
    const line = raw.trim();
    if (line === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new SessionPortFormatError(
        'invalid-json',
        `第 ${lineNumber} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (header === undefined) {
      header = parseHeaderLine(parsed);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SessionPortFormatError('invalid-event', `第 ${lineNumber} 行不是会话事件对象`);
    }
    events.push(parsed);
  }
  if (header === undefined) throw new SessionPortFormatError('empty-log', '文件里没有任何会话记录');
  return { header, events };
}

/**
 * Parse and sanity-check the first JSONL line.
 * @param {unknown} value - parsed first line.
 * @returns {object} the raw header line.
 */
export function parseHeaderLine(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionPortFormatError('invalid-header', '第一行不是会话头对象');
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.type !== 'session') {
    throw new SessionPortFormatError(
      'invalid-header',
      '第一行缺少 "type":"session" 标记，这不是 DSH 会话日志文件',
    );
  }
  if (typeof record.id !== 'string' || record.id === '') {
    throw new SessionPortFormatError('invalid-header', '会话头缺少会话 id');
  }
  if (!Number.isSafeInteger(record.version)) {
    throw new SessionPortFormatError('invalid-header', '会话头缺少合法的格式版本号');
  }
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw new SessionPortFormatError('invalid-header', '会话头缺少合法的创建时间');
  }
  return record;
}

/**
 * Validate the event body of one imported log before anything is written to
 * durable storage: contiguous `seq` from 0, JSON object payloads, and (when
 * the installed session package is resolvable) a known or ignorable type.
 * @param {ReadonlyArray<object>} events - parsed events.
 * @param {ReadonlySet<string> | undefined} knownTypes - vocabulary of the installed build.
 * @throws {SessionPortFormatError} on the first disqualifying event.
 */
export function validateEvents(events, knownTypes) {
  let expected = 0;
  for (const [index, event] of events.entries()) {
    const position = `第 ${index + 2} 行`;
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new SessionPortFormatError('invalid-event', `${position}不是会话事件对象`);
    }
    if (typeof event.type !== 'string' || event.type === '') {
      throw new SessionPortFormatError('invalid-event', `${position}缺少事件类型`);
    }
    if (event.seq !== expected) {
      throw new SessionPortFormatError(
        'event-seq',
        `${position}的事件序号是 ${String(event.seq)}，应为 ${expected}（事件必须从 0 开始连续排列）`,
      );
    }
    if (typeof event.time !== 'number' || !Number.isFinite(event.time)) {
      throw new SessionPortFormatError('invalid-event', `${position}缺少合法的时间戳`);
    }
    if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) {
      throw new SessionPortFormatError('invalid-event', `${position}的事件负载不是对象`);
    }
    if (knownTypes !== undefined && event.ignorable !== true && !knownTypes.has(event.type)) {
      throw new SessionPortFormatError(
        'unknown-event',
        `${position}的事件类型 "${event.type}" 本版本 DSH 不认识；请先用相同或更新版本的 DSH 升级/导出该会话`,
      );
    }
    expected += 1;
  }
  return expected;
}

/** Strip characters Windows and macOS refuse in a file name, then bound the length. */
export function sanitizeFileName(raw, fallback = 'session') {
  const cleaned = String(raw ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^\.+|\.+$/gu, '');
  const bounded = cleaned.slice(0, 60).trim();
  return bounded === '' ? fallback : bounded;
}

/**
 * Pick the root session log inside a DSH export archive.
 * Top-level `session[.vN].jsonl` wins (highest version); otherwise an archive
 * with exactly one top-level `.jsonl` is accepted.
 * @param {ReadonlyArray<{name: string}>} entries - archive entries in any order.
 * @returns {string | undefined} the chosen entry name.
 */
export function findRootLogEntry(entries) {
  const candidates = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.includes('/')) continue;
    const match = /^session(?:\.v(\d+))?\.jsonl$/iu.exec(name);
    if (match !== null) candidates.push({ name, version: match[1] === undefined ? 0 : Number(match[1]) });
  }
  if (candidates.length > 0) {
    candidates.sort((left, right) => right.version - left.version);
    return candidates[0].name;
  }
  const loose = entries.filter((entry) => !entry.name.includes('/') && /\.jsonl$/iu.test(entry.name));
  return loose.length === 1 ? loose[0].name : undefined;
}

/** Archive attachment entry name for one stored image reference. */
export function imageEntryName(ref) {
  const extension = MEDIA_TYPE_EXTENSIONS[ref.mediaType] ?? 'bin';
  return `media/${ref.attachmentId}.${extension}`;
}

/** Archive attachment entry name for one stored verbatim file reference. */
export function fileEntryName(ref) {
  const digest = String(ref.attachmentId).replace(/^sha256:/u, '');
  const prefix = digest.slice(0, 2);
  const safeName = sanitizeFileName(ref.name, 'file');
  return `files/${prefix}/${digest}/${safeName}`;
}

/**
 * Recover the stored attachment reference facts one archive entry names.
 * @param {string} name - archive entry name.
 * @returns {{kind: 'image'|'file'|'unknown', attachmentId?: string, mediaType?: string, digest?: string, baseName?: string}}
 */
export function parseAttachmentEntryName(name) {
  if (name.startsWith('media/')) {
    const baseName = name.slice('media/'.length);
    const dot = baseName.lastIndexOf('.');
    const extension = dot === -1 ? '' : baseName.slice(dot + 1).toLowerCase();
    const mediaType = EXTENSION_MEDIA_TYPES[extension];
    return {
      kind: mediaType === undefined ? 'unknown' : 'image',
      attachmentId: dot === -1 ? baseName : baseName.slice(0, dot),
      ...(mediaType === undefined ? {} : { mediaType }),
      baseName,
    };
  }
  if (name.startsWith('files/')) {
    const segments = name.split('/');
    // files/<prefix>/<digest>/<name>
    if (segments.length >= 4) {
      const digest = segments[2];
      return {
        kind: 'file',
        attachmentId: `sha256:${digest}`,
        digest,
        baseName: segments.slice(3).join('/'),
      };
    }
    return { kind: 'unknown', baseName: segments[segments.length - 1] };
  }
  return { kind: 'unknown', baseName: name };
}

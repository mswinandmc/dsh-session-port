/**
 * Integration tests for the Host-side export/import operations against a fake
 * service context. They exercise the real archive format end to end without a
 * Harness process: a fake `sessionQuery` supplies a log, a fake
 * `sessionPersistence` records what would be committed, and the ZIP reader
 * verifies what was written.
 *
 * Run with: node --test test/host.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectAttachmentRefs, parseSessionLog, serializeSessionLog } from '../lib/format.js';
import {
  DEFAULT_MAX_IMPORT_BYTES,
  defaultExportDirectory,
  detectFormatVersion,
  exportSession,
  importSession,
  readImportFile,
  servicesOf,
  writeExportFile,
} from '../lib/host.js';
import { readZipEntries, writeZipEntries } from '../lib/zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

const cwd = process.cwd();
const imageRef = {
  attachmentId: 'sha256:aaaa',
  mediaType: 'image/png',
  bytes: 68,
  width: 1,
  height: 1,
  name: 'pixel.png',
};

const events = [
  { type: 'turn/start', seq: 0, time: 1_700_000_000_100, data: { turn: 0 } },
  {
    type: 'user/message',
    seq: 1,
    time: 1_700_000_000_200,
    data: {
      role: 'user',
      id: 'm1',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '带附件的一条消息' },
        { type: 'image', attachment: imageRef },
      ],
    },
    surfaceOp: 'append',
  },
  {
    type: 'session/title',
    seq: 2,
    time: 1_700_000_000_300,
    data: { title: '测试会话', messageSeqs: [1], source: { kind: 'user' } },
  },
  { type: 'turn/end', seq: 3, time: 1_700_000_000_400, data: { turn: 0, reason: { kind: 'completed' } } },
];

const header = {
  version: 4,
  id: 'session-source-1',
  createdAt: 1_700_000_000_000,
  cwd,
  isSeeded: false,
};

/** A minimal fake Cordis context whose services record what the plugin writes. */
function fakeContext(options = {}) {
  const committed = { headers: [], batches: [], attached: [], flushed: [] };
  const services = {
    sessionQuery: {
      async listSessions() {
        return options.versions === undefined
          ? [{ header: { version: 4 } }]
          : options.versions.map((version) => ({ header: { version } }));
      },
      async traceSession(sessionId) {
        if (options.traceSession !== undefined) return options.traceSession(sessionId);
        return { target: { header: { id: sessionId } }, ancestors: [], descendants: [], complete: true };
      },
      async readSession(sessionId) {
        if (options.readSession !== undefined) return options.readSession(sessionId);
        // A session this import already created reads back from the recording
        // store, which is what the post-write verification checks.
        const created = committed.headers.find((entry) => entry.id === sessionId);
        if (created !== undefined) {
          if (options.verifyFails === true) throw new Error('replay validation failed');
          return { session: created, inheritedEventCount: 0, events: committed.batches.flat() };
        }
        if (sessionId !== header.id) {
          const error = new Error(`missing session ${sessionId}`);
          error.code = 'session/not-found';
          throw error;
        }
        return { session: header, inheritedEventCount: 0, events };
      },
      async readTitle(sessionId) {
        if (options.readTitle !== undefined) return options.readTitle(sessionId);
        // `sessionQuery.readTitle` resolves the folded title string itself.
        return '测试会话';
      },
    },
    sessionPersistence: {
      async stat() {
        return undefined;
      },
      async create(nextHeader) {
        committed.headers.push(nextHeader);
        return {
          header: nextHeader,
          async append(batch) {
            committed.batches.push(batch);
          },
          async flush() {},
          async close() {},
        };
      },
    },
    attachments: options.attachments,
    sessions:
      options.liveSession === undefined
        ? undefined
        : {
            get: (id) => (id === options.liveSession.id ? options.liveSession : undefined),
            async flush(session) {
              committed.flushed.push(session.id);
            },
          },
    workspaceRegistry: options.workspaceRegistry,
    workingDirectory: options.workingDirectory,
    agentPresets: options.agentPresets,
  };
  return {
    ctx: {
      get: (name) => services[name],
      logger: { warn() {} },
    },
    committed,
  };
}

test('detectFormatVersion reads the stored corpus, honors the configured override', async () => {
  const { ctx } = fakeContext({ versions: [3, 4, 4] });
  assert.equal(await detectFormatVersion(ctx, undefined), 4);
  assert.equal(await detectFormatVersion(ctx, 7), 7);
  const empty = fakeContext({ versions: [] });
  assert.equal(await detectFormatVersion(empty.ctx, undefined), 4);
});

test('servicesOf resolves optional services without throwing', () => {
  const { ctx } = fakeContext();
  const services = servicesOf(ctx);
  assert.equal(typeof services.sessionQuery, 'object');
  assert.equal(services.attachments, undefined);
});

test('exportSession produces DSH canonical JSONL inside a readable ZIP', async () => {
  const { ctx, committed } = fakeContext({
    liveSession: { id: header.id },
    attachments: {
      imageHostPath: () => join(fixtures, 'pixel.png'),
    },
  });
  const exported = await exportSession(ctx, { sessionId: header.id, signal: undefined });
  // A live session is flushed before its log is read.
  assert.deepEqual(committed.flushed, [header.id]);
  assert.match(exported.filename, /^测试会话-session-source-1\.zip$/u);
  assert.equal(exported.eventCount, events.length);
  assert.equal(exported.attachmentCount, 1);
  assert.deepEqual(exported.warnings, []);

  const entries = readZipEntries(exported.data);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['media/sha256:aaaa.png', 'session.v4.jsonl']);
  const parsed = parseSessionLog(Buffer.from(entries.find((entry) => entry.name === 'session.v4.jsonl').data).toString('utf8'));
  assert.equal(parsed.header.id, header.id);
  assert.equal(parsed.header.cwd, cwd);
  assert.equal(parsed.events.length, events.length);
  assert.deepEqual(parsed.events[1], events[1]);
});

test('exportSession to JSONL keeps the log and states the attachment limit', async () => {
  const { ctx } = fakeContext();
  const exported = await exportSession(ctx, { sessionId: header.id, format: 'jsonl' });
  assert.match(exported.filename, /\.jsonl$/u);
  assert.equal(exported.attachmentCount, 0);
  assert.equal(exported.warnings.length, 1);
  const parsed = parseSessionLog(exported.data.toString('utf8'));
  assert.equal(parsed.events.length, events.length);
});

test('exportSession names the archive from the queried title when the log carries none', async () => {
  // `sessionQuery.readTitle` resolves the title string directly; a log without a
  // title event must still be named after the session's title.
  const { ctx } = fakeContext({
    readSession: async () => ({
      session: header,
      inheritedEventCount: 0,
      events: events.filter((event) => event.type !== 'session/title'),
    }),
    readTitle: async () => '来自查询的标题',
  });
  const exported = await exportSession(ctx, { sessionId: header.id });
  assert.equal(exported.filename, `来自查询的标题-${header.id}.zip`);
});

test('exportSession reports an unknown session as a stable failure', async () => {
  const { ctx } = fakeContext();
  await assert.rejects(exportSession(ctx, { sessionId: 'session-missing' }), (error) => {
    assert.equal(error.code, 'not-found');
    assert.match(error.message, /session-missing/u);
    return true;
  });
  await assert.rejects(exportSession(ctx, { sessionId: '' }), (error) => error.code === 'missing-session');
});

/** One subagent child of the fixture session, with its own image attachment. */
function subagentFixture() {
  const childHeader = {
    version: 4,
    id: 'session-child-1',
    createdAt: header.createdAt + 1,
    cwd,
    isSeeded: false,
    parentSession: header.id,
    delegationDepth: 1,
    origin: 'subagent',
  };
  const childImage = { attachmentId: 'sha256:bbbb', mediaType: 'image/png', width: 2, height: 2, bytes: 9 };
  const childEvents = [
    {
      seq: 0,
      time: 1_700_000_000_500,
      type: 'user/message',
      data: { message: { content: [{ type: 'image', attachment: childImage }] } },
    },
  ];
  return { childHeader, childEvents };
}

test('exportSession packs every subagent log and its attachments', async () => {
  const { childHeader, childEvents } = subagentFixture();
  const { ctx } = fakeContext({
    attachments: { imageHostPath: () => join(fixtures, 'pixel.png') },
    traceSession: async () => ({
      target: { header },
      ancestors: [],
      descendants: [{ session: { header: childHeader }, descendants: [] }],
      complete: true,
    }),
    readSession: async (id) =>
      id === header.id ? { session: header, inheritedEventCount: 0, events } : { session: childHeader, inheritedEventCount: 0, events: childEvents },
  });
  const exported = await exportSession(ctx, { sessionId: header.id });
  assert.equal(exported.subagentCount, 1);
  assert.equal(exported.attachmentCount, 2);
  assert.deepEqual(exported.warnings, []);
  const names = readZipEntries(exported.data).map((entry) => entry.name).sort();
  assert.deepEqual(names, [
    'media/sha256:aaaa.png',
    'media/sha256:bbbb.png',
    'session.v4.jsonl',
    'subagents/session-child-1/session.v4.jsonl',
  ]);
  const childEntry = readZipEntries(exported.data).find((entry) => entry.name === 'subagents/session-child-1/session.v4.jsonl');
  assert.equal(parseSessionLog(Buffer.from(childEntry.data).toString('utf8')).header.id, 'session-child-1');
});

test('exportSession warns instead of failing when one subagent log is unreadable', async () => {
  const { childHeader } = subagentFixture();
  const { ctx } = fakeContext({
    traceSession: async () => ({
      target: { header },
      ancestors: [],
      descendants: [{ session: { header: childHeader }, descendants: [] }],
      complete: true,
    }),
    readSession: async (id) => {
      if (id === header.id) return { session: header, inheritedEventCount: 0, events };
      throw new Error('torn log');
    },
  });
  const exported = await exportSession(ctx, { sessionId: header.id, includeAttachments: false });
  assert.equal(exported.subagentCount, 0);
  assert.equal(exported.warnings.length, 1);
  assert.match(exported.warnings[0], /子会话 session-child-1 读取失败/u);
  assert.deepEqual(
    readZipEntries(exported.data).map((entry) => entry.name),
    ['session.v4.jsonl'],
  );
});

test('exportSession can leave subagents out on request', async () => {
  let traced = false;
  const { ctx } = fakeContext({
    traceSession: async () => {
      traced = true;
      return { target: { header }, ancestors: [], descendants: [], complete: true };
    },
  });
  const exported = await exportSession(ctx, { sessionId: header.id, includeDescendants: false });
  assert.equal(exported.subagentCount, 0);
  assert.equal(traced, false);
});

test('importSession flattens a forked log so the new session can be opened', async () => {
  // A fork's log starts with the parent's history behind an inherited end-seed
  // marker; the current-format reader refuses that inside an unseeded session.
  const forkedHeader = {
    version: 4,
    id: 'session-forked',
    createdAt: header.createdAt,
    cwd,
    isSeeded: true,
    parentSession: 'session-parent',
    delegationDepth: 1,
  };
  const forkedEvents = [
    { seq: 0, type: 'user/message', time: 1_700_000_000_100, data: { message: { content: [{ type: 'text', text: 'inherited' }] } } },
    { seq: 1, type: 'session/end-seed', time: 1_700_000_000_200, data: { inherited: true } },
    { seq: 2, type: 'session/title', time: 1_700_000_000_300, data: { title: '分支会话' } },
  ];
  const buffer = Buffer.from(serializeSessionLog(forkedHeader, forkedEvents), 'utf8');
  const target = fakeContext();
  const result = await importSession(target.ctx, { buffer, cwd });

  const created = target.committed.headers[0];
  assert.equal(created.isSeeded, false);
  assert.equal(created.parentSession, undefined);
  const written = target.committed.batches[0];
  assert.equal(written.length, 3);
  assert.equal(written[1].type, 'session/end-seed');
  assert.equal('inherited' in written[1].data, false);
  // Dense sequence and the rest of the history stay exactly as exported.
  assert.deepEqual(
    written.map((event) => event.seq),
    [0, 1, 2],
  );
  assert.deepEqual(written[2], forkedEvents[2]);
  assert.equal(result.verified, true);
  assert.deepEqual(result.warnings, []);
});

test('importSession reports a written session the reader cannot reopen', async () => {
  const buffer = Buffer.from(serializeSessionLog(header, events), 'utf8');
  const target = fakeContext({ verifyFails: true });
  const result = await importSession(target.ctx, { buffer, cwd });
  assert.equal(result.verified, false);
  assert.ok(result.warnings.some((line) => line.includes('无法重新打开')));
});

test('importSession round-trips an exported archive into a new standalone session', async () => {
  const source = fakeContext({
    attachments: { imageHostPath: () => join(fixtures, 'pixel.png') },
  });
  const exported = await exportSession(source.ctx, { sessionId: header.id });
  const target = fakeContext({
    attachments: {
      async saveImages() {
        return [{ attachmentId: imageRef.attachmentId, mediaType: 'image/png', bytes: imageRef.bytes, width: 1, height: 1 }];
      },
    },
  });
  const result = await importSession(target.ctx, {
    buffer: exported.data,
    cwd,
    filename: exported.filename,
  });

  assert.match(result.sessionId, /^session-[0-9a-f-]{36}$/u);
  assert.notEqual(result.sessionId, header.id);
  assert.equal(result.eventCount, events.length);
  assert.equal(result.title, '测试会话');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.attachmentCount, 1);
  assert.equal(target.committed.headers.length, 1);
  const created = target.committed.headers[0];
  assert.equal(created.version, 4);
  assert.equal(created.cwd, cwd);
  assert.equal(created.isSeeded, false);
  assert.equal(created.parentSession, undefined);
  assert.equal(created.agentPreset, undefined);
  assert.equal(created.createdAt, header.createdAt);
  assert.equal(target.committed.batches.length, 1);
  assert.deepEqual(target.committed.batches[0], events);
});

test('importSession reads a ZIP produced by a real external tool (PowerShell)', async () => {
  const buffer = readFileSync(join(fixtures, 'native-style-session.zip'));
  const target = fakeContext();
  const result = await importSession(target.ctx, { buffer, cwd });
  assert.equal(result.eventCount, 4);
  assert.equal(result.title, '导入测试会话');
  assert.equal(target.committed.batches[0].length, 4);
  assert.equal(target.committed.batches[0][0].seq, 0);
  assert.equal(target.committed.headers[0].cwd, cwd);
});

test('importSession reads a bare JSONL file, including one without events', async () => {
  const buffer = readFileSync(join(fixtures, 'zip-src', 'session.v4.jsonl'));
  const target = fakeContext();
  const result = await importSession(target.ctx, { buffer, cwd });
  assert.equal(result.eventCount, 4);

  const headerOnly = fakeContext();
  const emptyLog = `{"type":"session","version":4,"id":"session-blank","createdAt":1,"cwd":${JSON.stringify(cwd)},"isSeeded":false}\n`;
  const empty = await importSession(headerOnly.ctx, { buffer: Buffer.from(emptyLog), cwd });
  assert.equal(empty.eventCount, 0);
  assert.equal(headerOnly.committed.batches.length, 0);
  assert.equal(headerOnly.committed.headers.length, 1);
});

test('importSession restores attachments and rewrites their references', async () => {
  const log = parseSessionLog(readFileSync(join(fixtures, 'zip-src', 'session.v4.jsonl'), 'utf8'));
  const eventsWithImage = [
    log.events[0],
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: {
        role: 'user',
        id: 'm-img',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: { ...imageRef, attachmentId: 'sha256:old', bytes: 4 } }],
      },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: { kind: 'completed' } } },
  ];
  const archive = writeZipEntries([
    { name: 'session.v4.jsonl', data: Buffer.from([JSON.stringify(log.header), ...eventsWithImage.map((event) => JSON.stringify(event))].join('\n') + '\n') },
    { name: 'media/sha256:old.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  const saved = [];
  const target = fakeContext({
    attachments: {
      async saveImages(inputs) {
        saved.push(inputs);
        return [{ attachmentId: 'sha256:new', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }];
      },
    },
  });
  const result = await importSession(target.ctx, { buffer: archive, cwd });
  assert.equal(result.attachmentCount, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0].mediaType, 'image/png');
  const written = target.committed.batches[0];
  assert.equal(written[1].data.content[0].attachment.attachmentId, 'sha256:new');
  assert.equal(written[1].data.content[0].attachment.mediaType, 'image/png');
});

test('importSession attaches the new session to the resolved workspace', async () => {
  const attached = [];
  const workspaceRegistry = {
    get: () => undefined,
    async resolveByPath(path) {
      assert.equal(path, cwd);
      return {
        id: 'workspace-1',
        async attachSession(sessionId) {
          attached.push(sessionId);
        },
      };
    },
  };
  const target = fakeContext({ workspaceRegistry });
  const result = await importSession(target.ctx, {
    buffer: readFileSync(join(fixtures, 'zip-src', 'session.v4.jsonl')),
    cwd,
  });
  assert.equal(result.workspaceId, 'workspace-1');
  assert.deepEqual(attached, [result.sessionId]);
});

test('importSession falls back to the working-directory default when the source cwd is gone', async () => {
  const missingCwd = join(cwd, '__directory-that-does-not-exist__');
  const log = {
    type: 'session',
    version: 4,
    id: 'session-elsewhere',
    createdAt: 1,
    cwd: missingCwd,
    isSeeded: false,
  };
  const buffer = Buffer.from(`${JSON.stringify(log)}\n`);
  const target = fakeContext({ workingDirectory: { defaultDirectory: cwd } });
  const result = await importSession(target.ctx, { buffer });
  assert.equal(target.committed.headers[0].cwd, cwd);
  assert.equal(result.eventCount, 0);
});

test('importSession drops an agent preset this Harness does not know', async () => {
  const log = {
    type: 'session',
    version: 4,
    id: 'session-preset',
    createdAt: 1,
    cwd,
    isSeeded: false,
    agentPreset: 'preset-from-another-machine',
  };
  const buffer = Buffer.from(`${JSON.stringify(log)}\n`);
  const unknown = fakeContext({
    agentPresets: {
      async resolve() {
        throw new Error('agent-preset/not-found');
      },
    },
  });
  await importSession(unknown.ctx, { buffer, cwd });
  assert.equal(unknown.committed.headers[0].agentPreset, undefined);

  const known = fakeContext({ agentPresets: { async resolve(id) { return { id }; } } });
  await importSession(known.ctx, { buffer, cwd });
  assert.equal(known.committed.headers[0].agentPreset, 'preset-from-another-machine');
});

test('importSession refuses files that are empty, oversized, foreign or invalid', async () => {
  const target = fakeContext();
  await assert.rejects(importSession(target.ctx, { buffer: Buffer.alloc(0) }), (error) => error.code === 'empty-file');
  await assert.rejects(
    importSession(target.ctx, { buffer: Buffer.from('x'), maxImportBytes: 0 }),
    (error) => error.code === 'too-large',
  );
  await assert.rejects(
    importSession(target.ctx, { buffer: Buffer.from('{"hello":1}\n') }),
    (error) => error.code === 'invalid-header',
  );
  await assert.rejects(
    importSession(target.ctx, { buffer: Buffer.from('not a session') }),
    (error) => error.code === 'invalid-json',
  );
  await assert.rejects(
    importSession(target.ctx, { buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]) }),
    (error) => error.code === 'invalid-zip',
  );
  assert.equal(DEFAULT_MAX_IMPORT_BYTES, 512 * 1024 * 1024);
});

test('importSession refuses a format version the running build does not use', async () => {
  const log = { type: 'session', version: 3, id: 'session-v3', createdAt: 1, cwd, isSeeded: false };
  const target = fakeContext();
  await assert.rejects(importSession(target.ctx, { buffer: Buffer.from(`${JSON.stringify(log)}\n`) }), (error) => {
    assert.equal(error.code, 'format-version');
    assert.match(error.message, /v3/u);
    return true;
  });
});

test('importSession refuses non-contiguous event logs before writing anything', async () => {
  const log = { type: 'session', version: 4, id: 'session-gap', createdAt: 1, cwd, isSeeded: false };
  const broken = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 0, reason: { kind: 'completed' } } },
  ];
  const buffer = Buffer.from([JSON.stringify(log), ...broken.map((event) => JSON.stringify(event))].join('\n') + '\n');
  const target = fakeContext();
  await assert.rejects(importSession(target.ctx, { buffer, cwd }), (error) => error.code === 'event-seq');
  assert.equal(target.committed.headers.length, 0);
  assert.equal(target.committed.batches.length, 0);
});

test('writeExportFile writes the archive into the requested directory', async () => {
  const { childHeader, childEvents } = subagentFixture();
  const { ctx } = fakeContext({
    traceSession: async () => ({
      target: { header },
      ancestors: [],
      descendants: [{ session: { header: childHeader }, descendants: [] }],
      complete: true,
    }),
    readSession: async (id) =>
      id === header.id ? { session: header, inheritedEventCount: 0, events } : { session: childHeader, inheritedEventCount: 0, events: childEvents },
  });
  const directory = mkdtempSync(join(tmpdir(), 'session-port-test-'));
  try {
    const written = await writeExportFile(ctx, { sessionId: header.id, directory });
    assert.equal(dirname(written.path), directory);
    assert.match(written.filename, /\.zip$/u);
    // The tool result reports the tree it actually packed.
    assert.equal(written.subagentCount, 1);
    const entries = readZipEntries(readFileSync(written.path));
    assert.ok(entries.some((entry) => entry.name === 'session.v4.jsonl'));
    assert.ok(entries.some((entry) => entry.name === 'subagents/session-child-1/session.v4.jsonl'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.match(defaultExportDirectory(), /session-port[\\/]exports$/u);
});

test('readImportFile resolves relative paths and enforces the size cap', async () => {
  const file = await readImportFile(join('fixtures', 'zip-src', 'session.v4.jsonl'), { cwd: join(here) });
  assert.equal(file.filename, 'session.v4.jsonl');
  assert.ok(file.buffer.length > 0);
  await assert.rejects(readImportFile('fixtures/nope.zip', { cwd: here }), (error) => error.code === 'file-missing');
  await assert.rejects(
    readImportFile(join('fixtures', 'zip-src', 'session.v4.jsonl'), { cwd: here, maxImportBytes: 1 }),
    (error) => error.code === 'too-large',
  );
});

test('attachment references survive an export→import round trip with identical ids', async () => {
  const written = [];
  const source = fakeContext({
    attachments: { imageHostPath: () => join(fixtures, 'pixel.png') },
  });
  const exported = await exportSession(source.ctx, { sessionId: header.id });
  const target = fakeContext({
    attachments: {
      async saveImages(inputs) {
        written.push(...inputs);
        return [{ attachmentId: imageRef.attachmentId, mediaType: 'image/png', bytes: 68, width: 1, height: 1 }];
      },
    },
  });
  const result = await importSession(target.ctx, { buffer: exported.data, cwd });
  assert.equal(result.attachmentCount, 1);
  assert.equal(written.length, 1);
  // Saving identical bytes yields the same content-addressed id, so the log is
  // preserved byte for byte in this case.
  assert.deepEqual(target.committed.batches[0], events);
  assert.deepEqual(collectAttachmentRefs(target.committed.batches[0]).images.size, 1);
});

test('file attachment names survive an export→import round trip verbatim', async () => {
  // The attachment store accepts names up to 255 UTF-8 bytes and canonicalizes
  // only the characters file systems refuse. The archive must carry that name
  // unchanged — DSH's own session-log export does — so a long CJK name must not
  // come back shorter after a round trip.
  const fileName = `${'长'.repeat(80)}.txt`;
  const fileDigest = 'd'.repeat(64);
  const fileRef = { attachmentId: `sha256:${fileDigest}`, name: fileName, bytes: 7 };
  const fileEvents = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: {
        role: 'user',
        id: 'm1',
        source: { kind: 'user' },
        content: [{ type: 'file', attachment: fileRef }],
      },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: { kind: 'completed' } } },
  ];

  const source = fakeContext({
    readSession: async () => ({ session: header, inheritedEventCount: 0, events: fileEvents }),
    attachments: { fileHostPath: () => join(fixtures, 'zip-src', 'session.v4.jsonl') },
  });
  const exported = await exportSession(source.ctx, { sessionId: header.id, includeDescendants: false });
  const expectedEntry = `files/${fileDigest.slice(0, 2)}/${fileDigest}/${fileName}`;
  const entries = readZipEntries(exported.data);
  assert.ok(entries.some((entry) => entry.name === expectedEntry), `archive lacks ${expectedEntry}`);

  const stored = [];
  const target = fakeContext({
    attachments: {
      async saveFile({ data, name }) {
        stored.push({ data, name });
        return { attachmentId: `sha256:${fileDigest}`, name, bytes: data.byteLength };
      },
    },
  });
  const result = await importSession(target.ctx, { buffer: exported.data, cwd });
  assert.equal(result.attachmentCount, 1);
  assert.equal(result.verified, true);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, fileName);
  const importedRef = collectAttachmentRefs(target.committed.batches[0]).files.get(`sha256:${fileDigest}`);
  assert.equal(importedRef.name, fileName);
});

test('importSession re-points session-log delivery markers at the new session', async () => {
  // A log exported from another session carries delivery-accepted markers that
  // name that session. The current-format reader refuses such a log, so the
  // importer must rewrite the markers before writing.
  const source = {
    type: 'session',
    version: 4,
    id: 'session-original',
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
  };
  const events = [
    { type: 'turn/start', seq: 0, time: 1_700_000_000_100, data: { turn: 0 } },
    {
      type: 'session-log-deepseek/delivery-accepted',
      seq: 1,
      time: 1_700_000_000_200,
      data: { sessionId: 'session-original', sessionFormatVersion: 4, throughSeq: 0 },
    },
    {
      type: 'turn/end',
      seq: 2,
      time: 1_700_000_000_300,
      data: { turn: 0, reason: { kind: 'completed' } },
    },
  ];
  const buffer = Buffer.from([JSON.stringify(source), ...events.map((event) => JSON.stringify(event))].join('\n') + '\n');
  const target = fakeContext();
  const result = await importSession(target.ctx, { buffer, cwd });
  const written = target.committed.batches[0];
  assert.equal(written[1].data.sessionId, result.sessionId);
  assert.equal(written[1].data.throughSeq, 0);
  assert.equal(written[1].data.sessionFormatVersion, 4);
  // Everything else is preserved as imported.
  assert.deepEqual(written[0], events[0]);
  assert.deepEqual(written[2], events[2]);
  // The source array is untouched.
  assert.equal(events[1].data.sessionId, 'session-original');
});

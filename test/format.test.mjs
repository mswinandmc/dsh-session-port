/**
 * Unit tests for the pure session-log format helpers.
 * Run with: node --test test/format.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionPortFormatError,
  collectAttachmentRefs,
  fileEntryName,
  findRootLogEntry,
  imageEntryName,
  isZipBuffer,
  parseAttachmentEntryName,
  parseSessionLog,
  rewriteAttachmentRefs,
  rewriteDeliveryIdentity,
  rewriteSeedMarkers,
  sanitizeFileName,
  serializeSessionLog,
  sessionLogFileName,
  subagentLogEntryName,
  validateEvents,
} from '../lib/format.js';

const header = {
  version: 4,
  id: 'session-test-1',
  createdAt: 1_700_000_000_000,
  cwd: 'D:\\work\\demo',
  parentSession: 'session-parent',
  isSeeded: true,
  origin: 'subagent',
  delegationDepth: 2,
  agentPreset: 'standard',
};

const imageRef = {
  attachmentId: 'sha256:aaaa',
  mediaType: 'image/png',
  bytes: 12,
  width: 2,
  height: 2,
  name: 'shot.png',
};
const fileRef = { attachmentId: 'sha256:bbbb', name: 'notes.txt', bytes: 5 };

const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
  {
    type: 'user/message',
    seq: 1,
    time: 2,
    data: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'image', attachment: imageRef }] },
    surfaceOp: 'append',
  },
  {
    type: 'tool/result',
    seq: 2,
    time: 3,
    data: {
      turn: 0,
      step: 0,
      message: {
        role: 'tool',
        id: 'm2',
        source: { kind: 'tool', callId: 'c1' },
        toolCallId: 'c1',
        content: [{ type: 'file', attachment: fileRef }],
      },
    },
    surfaceOp: 'append',
  },
  { type: 'custom/unknown', seq: 3, time: 4, data: {}, ignorable: true },
];

test('serializeSessionLog mirrors the shipped header line and keeps events verbatim', () => {
  const text = serializeSessionLog(header, events);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, events.length + 1);
  const parsedHeader = JSON.parse(lines[0]);
  assert.equal(parsedHeader.type, 'session');
  assert.equal(parsedHeader.version, 4);
  assert.equal(parsedHeader.id, header.id);
  assert.equal(parsedHeader.delegationDepth, 2);
  assert.equal(parsedHeader.isSeeded, true);
  assert.deepEqual(JSON.parse(lines[3]), events[2]);
  assert.ok(text.endsWith('\n'));
});

test('a serialized log parses back to the same events', () => {
  const parsed = parseSessionLog(serializeSessionLog(header, events));
  assert.equal(parsed.header.id, header.id);
  assert.equal(parsed.events.length, events.length);
  assert.deepEqual(parsed.events[1], events[1]);
});

test('headers without optional fields stay minimal', () => {
  const minimal = { version: 4, id: 'session-min', createdAt: 1, isSeeded: false };
  const line = JSON.parse(serializeSessionLog(minimal, []).trimEnd().split('\n')[0]);
  assert.deepEqual(line, {
    type: 'session',
    version: 4,
    id: 'session-min',
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
  });
});

test('parseSessionLog survives CRLF, blank lines and a BOM-free read', () => {
  const text = serializeSessionLog(header, events).replaceAll('\n', '\r\n') + '\r\n';
  const parsed = parseSessionLog(text);
  assert.equal(parsed.events.length, events.length);
});

test('parseSessionLog rejects non-session documents with a stable code', () => {
  assert.throws(
    () => parseSessionLog('{"hello":"world"}\n'),
    (error) => error instanceof SessionPortFormatError && error.code === 'invalid-header',
  );
  assert.throws(
    () => parseSessionLog('not json\n'),
    (error) => error instanceof SessionPortFormatError && error.code === 'invalid-json',
  );
  assert.throws(
    () => parseSessionLog('\n\n'),
    (error) => error instanceof SessionPortFormatError && error.code === 'empty-log',
  );
  assert.throws(
    () => parseSessionLog('{"type":"session","version":4,"id":"s","createdAt":1}\n[]\n'),
    (error) => error instanceof SessionPortFormatError && error.code === 'invalid-event',
  );
});

test('validateEvents enforces contiguous seq and known vocabulary', () => {
  assert.equal(validateEvents(events), events.length);
  const knownTypes = new Set(events.map((event) => event.type));
  assert.equal(validateEvents(events, knownTypes), events.length);
  // An unknown type is fine only when the event declares itself ignorable.
  assert.throws(
    () => validateEvents([{ type: 'future/event', seq: 0, time: 1, data: {} }], knownTypes),
    (error) => error instanceof SessionPortFormatError && error.code === 'unknown-event',
  );
  assert.equal(validateEvents([{ type: 'future/event', seq: 0, time: 1, data: {}, ignorable: true }], knownTypes), 1);
  assert.throws(
    () => validateEvents([{ type: 'turn/start', seq: 1, time: 1, data: {} }]),
    (error) => error instanceof SessionPortFormatError && error.code === 'event-seq',
  );
  assert.throws(
    () => validateEvents([{ type: 'turn/start', seq: 0, time: 1, data: null }]),
    (error) => error instanceof SessionPortFormatError && error.code === 'invalid-event',
  );
  assert.throws(
    () => validateEvents([{ type: 'turn/start', seq: 0, data: {} }]),
    (error) => error instanceof SessionPortFormatError && error.code === 'invalid-event',
  );
});

test('attachment refs are collected once per id and classified by shape', () => {
  const refs = collectAttachmentRefs(events);
  assert.deepEqual([...refs.images.keys()], ['sha256:aaaa']);
  assert.deepEqual([...refs.files.keys()], ['sha256:bbbb']);
  // Duplicates across events dedupe by attachment id.
  const twice = collectAttachmentRefs([...events, ...events]);
  assert.equal(twice.images.size, 1);
  assert.equal(twice.files.size, 1);
  // An unknown attachment-like object with the wrong shape is not a reference.
  const unrelated = collectAttachmentRefs([
    { type: 'x', seq: 0, time: 1, data: { attachmentId: 'opaque', unrelated: true } },
  ]);
  assert.equal(unrelated.images.size + unrelated.files.size, 0);
});

test('rewriteAttachmentRefs swaps ids and adopts stored metadata without mutating input', () => {
  const storedImage = {
    attachmentId: 'sha256:new-image',
    mediaType: 'image/png',
    bytes: 12,
    width: 2,
    height: 2,
  };
  const storedFile = { attachmentId: 'sha256:new-file', name: 'notes.txt', bytes: 5 };
  const replacements = new Map([
    ['sha256:aaaa', storedImage],
    ['sha256:bbbb', storedFile],
  ]);
  const rewritten = rewriteAttachmentRefs(events, replacements);
  const rewrittenImage = rewritten[1].data.content[0].attachment;
  assert.equal(rewrittenImage.attachmentId, 'sha256:new-image');
  assert.equal(rewrittenImage.mediaType, 'image/png');
  const rewrittenFile = rewritten[2].data.message.content[0].attachment;
  assert.equal(rewrittenFile.attachmentId, 'sha256:new-file');
  assert.equal(rewrittenFile.name, 'notes.txt');
  // Input is untouched, and untouched events keep their identity.
  assert.equal(events[1].data.content[0].attachment.attachmentId, 'sha256:aaaa');
  assert.equal(rewritten[0], events[0]);
  assert.equal(rewritten[3], events[3]);
  assert.deepEqual(rewritten[1], {
    ...events[1],
    data: {
      ...events[1].data,
      content: [{ type: 'image', attachment: rewrittenImage }],
    },
  });
});

test('sanitizeFileName removes characters a file system refuses', () => {
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(sanitizeFileName('  ..名字..  '), '名字');
  assert.equal(sanitizeFileName(''), 'session');
  assert.equal(sanitizeFileName(undefined, 'fallback'), 'fallback');
  assert.ok(sanitizeFileName('x'.repeat(200)).length <= 60);
});

test('findRootLogEntry prefers the highest version and accepts one loose log', () => {
  const entries = [
    { name: 'media/sha256:a.png' },
    { name: 'session.jsonl' },
    { name: 'session.v3.jsonl' },
    { name: 'session.v4.jsonl' },
    { name: 'subagents/x/session.v4.jsonl' },
  ];
  assert.equal(findRootLogEntry(entries), 'session.v4.jsonl');
  assert.equal(findRootLogEntry([{ name: 'session.jsonl' }]), 'session.jsonl');
  assert.equal(findRootLogEntry([{ name: 'backup.jsonl' }]), 'backup.jsonl');
  assert.equal(findRootLogEntry([{ name: 'a.jsonl' }, { name: 'b.jsonl' }]), undefined);
  assert.equal(findRootLogEntry([{ name: 'media/x.png' }]), undefined);
  assert.equal(sessionLogFileName(4), 'session.v4.jsonl');
  assert.equal(sessionLogFileName(0), 'session.jsonl');
});

test('attachment archive entry names round-trip through their parser', () => {
  assert.equal(imageEntryName(imageRef), 'media/sha256:aaaa.png');
  const imageName = parseAttachmentEntryName(imageEntryName(imageRef));
  assert.equal(imageName.kind, 'image');
  assert.equal(imageName.attachmentId, 'sha256:aaaa');
  assert.equal(imageName.mediaType, 'image/png');

  const storedFile = { attachmentId: `sha256:${'c'.repeat(64)}`, name: '季度 报告.pdf', bytes: 9 };
  const entryName = fileEntryName(storedFile);
  assert.match(entryName, /^files\/cc\/c{64}\/季度 报告\.pdf$/u);
  const parsedFile = parseAttachmentEntryName(entryName);
  assert.equal(parsedFile.kind, 'file');
  assert.equal(parsedFile.attachmentId, storedFile.attachmentId);
  assert.equal(parsedFile.baseName, '季度 报告.pdf');
});

test('isZipBuffer recognizes local headers and end-of-archive records only', () => {
  assert.equal(isZipBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);
  assert.equal(isZipBuffer(Buffer.from([0x50, 0x4b, 0x05, 0x06])), true);
  assert.equal(isZipBuffer(Buffer.from('{"type":"session"}')), false);
  assert.equal(isZipBuffer(Buffer.alloc(0)), false);
});

test('rewriteDeliveryIdentity re-points active-generation delivery markers only', () => {
  const marker = {
    type: 'session-log-deepseek/delivery-accepted',
    seq: 4,
    time: 5,
    data: { sessionId: 'session-source', sessionFormatVersion: 4, throughSeq: 3 },
  };
  const oldGeneration = {
    type: 'session-log-deepseek/delivery-accepted',
    seq: 5,
    time: 6,
    data: { sessionId: 'session-source', sessionFormatVersion: 3, throughSeq: 4 },
  };
  const other = { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } };
  const events = [other, marker, oldGeneration];
  const rewritten = rewriteDeliveryIdentity(events, 'session-copy', 4);
  assert.equal(rewritten.length, 3);
  assert.equal(rewritten[1].data.sessionId, 'session-copy');
  assert.equal(rewritten[1].data.throughSeq, 3);
  assert.equal(rewritten[1].data.sessionFormatVersion, 4);
  // Markers of another generation are ignored by the reader and stay untouched.
  assert.equal(rewritten[2].data.sessionId, 'session-source');
  // Untouched events keep their identity.
  assert.equal(rewritten[0], other);
  // Input stays pristine.
  assert.equal(events[1].data.sessionId, 'session-source');
  // Already-pointing markers do not force a copy.
  const alreadyOurs = [{ ...marker, data: { ...marker.data, sessionId: 'session-copy' } }];
  assert.equal(rewriteDeliveryIdentity(alreadyOurs, 'session-copy', 4), alreadyOurs);
  // No marker to rewrite -> the exact same array comes back.
  const unchanged = [other];
  assert.equal(rewriteDeliveryIdentity(unchanged, 'session-copy', 4), unchanged);
});

test('rewriteSeedMarkers flattens the inherited cut without touching history', () => {
  const inherited = {
    type: 'session/end-seed',
    seq: 3,
    time: 4,
    data: { inherited: true },
  };
  const plainSeed = { type: 'session/end-seed', seq: 7, time: 8, data: {} };
  const before = { type: 'user/message', seq: 2, time: 3, data: { message: { content: [] } } };
  const events = [before, inherited, plainSeed];
  const rewritten = rewriteSeedMarkers(events);
  // The marker stays at its seq — only the seeded-only flag disappears, so the
  // rest of the log keeps its dense sequence untouched.
  assert.equal(rewritten[1].type, 'session/end-seed');
  assert.equal(rewritten[1].seq, 3);
  assert.equal('inherited' in rewritten[1].data, false);
  assert.deepEqual(rewritten[1].data, {});
  // A plain marker and ordinary events keep their identity.
  assert.equal(rewritten[2], plainSeed);
  assert.equal(rewritten[0], before);
  // The input log is not mutated.
  assert.equal(events[1].data.inherited, true);
  // Nothing to flatten -> the exact same array comes back.
  const untouched = [before, plainSeed];
  assert.equal(rewriteSeedMarkers(untouched), untouched);
});

test('subagentLogEntryName mirrors the shipped subagents/ layout', () => {
  assert.equal(subagentLogEntryName('session-a1', 4), 'subagents/session-a1/session.v4.jsonl');
  assert.equal(subagentLogEntryName('session-a1', undefined), 'subagents/session-a1/session.jsonl');
  // Separators and dots cannot escape the folder.
  assert.equal(subagentLogEntryName('../evil id', 4), 'subagents/___evil_id/session.v4.jsonl');
});

/**
 * Unit tests for the cancel plumbing shared by the export route and the ZIP
 * writer. The regression this guards is a backpressure wait that never settles
 * after a client disconnect: `drain` never fires on a destroyed response, so
 * without an abort path the producing export would stay pending forever.
 *
 * Run with: node --test test/abort.test.mjs
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { abortReason, throwIfAborted, waitForDrain } from '../lib/abort.js';

test('waitForDrain settles on drain', async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  assert.equal(stream.write(Buffer.alloc(64, 1)), false, '缓冲区必须写满才能等到 drain');
  const waiting = waitForDrain(stream, undefined);
  stream.read();
  await waiting;
  stream.destroy();
});

test('waitForDrain rejects with the stream error instead of waiting forever', async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  assert.equal(stream.write(Buffer.alloc(64, 1)), false);
  const waiting = waitForDrain(stream, undefined);
  stream.destroy(new Error('disk full'));
  await assert.rejects(waiting, /disk full/u);
});

test('waitForDrain rejects as soon as the caller aborts', async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  assert.equal(stream.write(Buffer.alloc(64, 1)), false);
  const controller = new AbortController();
  const waiting = waitForDrain(stream, controller.signal);
  controller.abort(new Error('client disconnected'));
  await assert.rejects(waiting, /client disconnected/u);
  stream.destroy();
});

test('waitForDrain never waits on an already aborted signal', async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForDrain(stream, controller.signal), (error) => error.code === 'ABORTED');
  stream.destroy();
});

test('throwIfAborted is silent without a signal and carries a stable code', () => {
  assert.equal(throwIfAborted(undefined), undefined);
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => throwIfAborted(controller.signal),
    (error) => error.name === 'AbortError' && error.code === 'ABORTED',
  );
  assert.equal(abortReason(controller.signal).code, 'ABORTED');
});

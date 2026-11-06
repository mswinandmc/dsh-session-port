/**
 * Session Port — cancellation plumbing shared by the Host operations, the ZIP
 * writer and the browser route.
 *
 * A cancelled export has two independently failing halves: the producer (log
 * read, attachment streams) and the consumer (an HTTP response whose client
 * went away, or a file stream that hit a disk error). Both need to observe the
 * same signal, and a backpressure wait must not outlive the consumer — otherwise
 * one closed browser tab leaves an export task pending forever.
 *
 * @module dsh-session-port/abort
 */

/**
 * The rejection value for one aborted operation.
 *
 * `AbortSignal.reason` carries whatever the aborting code passed; a deliberately
 * constructed Error is preserved, while a bare abort (Node's generic
 * `AbortError`) or a string reason becomes a stable error carrying `code`
 * `ABORTED`, which callers can test without matching messages.
 * @param {AbortSignal | undefined} signal - the aborted signal.
 * @returns {Error} a rejection value.
 */
export function abortReason(signal) {
  const reason = signal?.reason;
  // A generic AbortError (Node's default for `abort()` without a reason) says
  // nothing useful; keep a reason the caller constructed on purpose.
  if (reason instanceof Error && reason.name !== 'AbortError') return reason;
  const error = new Error(typeof reason === 'string' && reason !== '' ? reason : '操作已被取消');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

/**
 * Throw when the caller's signal is already aborted.
 * @param {AbortSignal | undefined} signal - cancellation to observe.
 * @returns {void}
 * @throws {Error} the abort reason.
 */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortReason(signal);
}

/**
 * Wait for a writable to accept more bytes, or reject as soon as the write side
 * becomes unusable.
 *
 * A plain `events.once(stream, 'drain')` never settles after a client disconnect
 * (a destroyed socket produces neither `drain` nor `error`), which would strand
 * the producing export. This waiter settles on `drain`, rejects on `error`, and
 * rejects on the caller's abort — removing every listener it installed, so a
 * long export cannot accumulate listeners across backpressure waits.
 * @param {import('node:stream').Writable} stream - the stream being written.
 * @param {AbortSignal | undefined} signal - cancellation to observe.
 * @returns {Promise<void>} resolves when more bytes may be written.
 * @throws the abort reason, or the stream's own error.
 */
export function waitForDrain(stream, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    stream.once('drain', onDrain);
    stream.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

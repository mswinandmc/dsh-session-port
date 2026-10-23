/**
 * Session Port — attachment packing and restore for import/export archives.
 *
 * DSH keeps attachment bytes in a content-addressed store; a session log only
 * carries references. The shipped session-log export writes images under
 * `media/<attachmentId>.<ext>` and verbatim files under
 * `files/<prefix>/<digest>/<name>`, and this module reproduces that layout on
 * both sides so an archive from either producer can be read by the other.
 *
 * The attachment service surface is resolved from `ctx.attachments` at call
 * time: host-file-backed backends are read from disk directly, while any other
 * backend goes through `readImage` / `readFileStream`.
 *
 * @module dsh-session-port/attachments
 */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

import { fileEntryName, imageEntryName, parseAttachmentEntryName } from './format.js';

/**
 * Read one image's stored bytes, preferring the provider's host path so large
 * images do not pass through the request-image machinery.
 * @param {object} attachments - the composed attachment service.
 * @param {object} ref - durable image reference from the session log.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<Uint8Array>} normalized image bytes.
 */
async function readImageBytes(attachments, ref, signal) {
  const hostPath = typeof attachments.imageHostPath === 'function' ? attachments.imageHostPath(ref) : undefined;
  if (typeof hostPath === 'string' && hostPath !== '') return new Uint8Array(await readFile(hostPath));
  const stored = await attachments.readImage(ref, signal);
  return stored.data instanceof Uint8Array ? stored.data : new Uint8Array(stored.data);
}

/**
 * Plan the archive entries for one session's attachment references.
 *
 * Each reference is resolved to an *opener*, so the exporter can write one
 * entry at a time instead of holding every attachment in memory: host-file
 * backed attachments stay on disk and are streamed into the archive, images are
 * read through [`readImageBytes`], and other-service files are streamed when
 * the service offers `readFileStream`.
 *
 * Problems detectable without reading content (no attachment service, a service
 * with neither host path nor stream, a malformed reference) become warnings so
 * the export still succeeds without that entry. Failures that only show up when
 * the entry is opened are reported by [`iteratePlannedEntries`] the same way,
 * *before* that entry's header is written, so the archive stays valid.
 * A failure in the middle of a streamed file cannot be rolled back; it rejects
 * the whole export rather than producing a corrupt archive silently.
 *
 * @param {object | undefined} attachments - the composed attachment service.
 * @param {{images: Map<string, object>, files: Map<string, object>}} refs - collected references.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{entries: Array<{name: string, open: () => Promise<{data: Uint8Array | AsyncIterable<Uint8Array>}>}>, warnings: string[]}>} entry plan.
 */
export async function planAttachmentEntries(attachments, refs, signal) {
  /** @type {Array<{name: string, open: () => Promise<{data: Uint8Array | AsyncIterable<Uint8Array>}>}>} */
  const entries = [];
  const warnings = [];
  if (attachments === undefined) {
    if (refs.images.size + refs.files.size > 0) warnings.push('会话引用了附件，但当前未挂载附件服务，附件不会被导出');
    return { entries, warnings };
  }
  for (const ref of refs.images.values()) {
    let name;
    try {
      name = imageEntryName(ref);
    } catch (error) {
      warnings.push(`图片 ${String(ref.attachmentId)} 的归档名无法生成：${errorText(error)}`);
      continue;
    }
    entries.push({ name, open: async () => ({ data: await readImageBytes(attachments, ref, signal) }) });
  }
  for (const ref of refs.files.values()) {
    let name;
    try {
      name = fileEntryName(ref);
    } catch (error) {
      warnings.push(`文件 ${String(ref.name)} 的归档名无法生成：${errorText(error)}`);
      continue;
    }
    const hostPath = typeof attachments.fileHostPath === 'function' ? attachments.fileHostPath(ref) : undefined;
    if (typeof hostPath === 'string' && hostPath !== '') {
      entries.push({
        name,
        // `stat` up front keeps a missing file a skipped entry instead of a
        // half-written one; the bytes themselves never enter this process whole.
        open: async () => {
          const info = await stat(hostPath);
          if (!info.isFile()) throw new Error('存储路径不是文件');
          return { data: createReadStream(hostPath) };
        },
      });
      continue;
    }
    if (typeof attachments.readFileStream === 'function') {
      entries.push({ name, open: async () => ({ data: attachments.readFileStream(ref, signal) }) });
      continue;
    }
    warnings.push(`文件 ${ref.name} 无法读取：附件服务既不提供本地路径也不提供流式读取`);
  }
  return { entries, warnings };
}

/**
 * Open planned attachment entries one at a time, yielding the bytes or stream
 * for one entry before touching the next.
 * @param {Array<{name: string, open: () => Promise<{data: Uint8Array | AsyncIterable<Uint8Array>}>}>} entries - plan from [`planAttachmentEntries`].
 * @param {string[]} warnings - collector mutated when an entry cannot be opened.
 * @param {{count: number}} stats - mutated with the number of entries yielded.
 * @returns {AsyncGenerator<{name: string, data: Uint8Array | AsyncIterable<Uint8Array>}>} archive entries.
 */
export async function* iteratePlannedEntries(entries, warnings, stats) {
  for (const entry of entries) {
    let opened;
    try {
      opened = await entry.open();
    } catch (error) {
      warnings.push(`附件 ${entry.name} 读取失败：${errorText(error)}`);
      continue;
    }
    stats.count += 1;
    yield { name: entry.name, data: opened.data };
  }
}

/**
 * Re-commit one archive's attachment entries into the local attachment store
 * and return the reference replacements a rewritten log needs.
 * @param {object | undefined} attachments - the composed attachment service.
 * @param {ReadonlyArray<{name: string, data: Uint8Array}>} entries - archive entries.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{replacements: Map<string, object>, warnings: string[], images: number, files: number}>} restore result.
 */
export async function restoreAttachmentEntries(attachments, entries, signal) {
  const replacements = new Map();
  const warnings = [];
  let images = 0;
  let files = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const parsed = parseAttachmentEntryName(entry.name);
    if (parsed.kind === 'image' && parsed.attachmentId !== undefined) {
      if (attachments === undefined) {
        warnings.push('当前未挂载附件服务，图片不会被恢复');
        continue;
      }
      try {
        // One image per call: the batch limits belong to prompt uploads, not restores.
        const [ref] = await attachments.saveImages([{ data: entry.data, mediaType: parsed.mediaType }]);
        if (ref !== undefined) {
          replacements.set(parsed.attachmentId, ref);
          images += 1;
        }
      } catch (error) {
        warnings.push(`图片 ${parsed.baseName ?? entry.name} 恢复失败：${errorText(error)}`);
      }
      continue;
    }
    if (parsed.kind === 'file' && parsed.attachmentId !== undefined) {
      if (attachments === undefined) {
        warnings.push('当前未挂载附件服务，文件不会被恢复');
        continue;
      }
      try {
        const ref = await attachments.saveFile({ data: entry.data, name: parsed.baseName ?? 'file' });
        if (ref !== undefined) {
          replacements.set(parsed.attachmentId, ref);
          files += 1;
        }
      } catch (error) {
        warnings.push(`文件 ${parsed.baseName ?? entry.name} 恢复失败：${errorText(error)}`);
      }
    }
  }
  return { replacements, warnings, images, files };
}

/**
 * The short message of an arbitrary thrown value.
 * @param {unknown} error - thrown value.
 * @returns {string} one-line diagnostic.
 */
export function errorText(error) {
  if (error instanceof Error) return error.message.split('\n')[0];
  return String(error);
}

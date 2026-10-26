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

import { readFile } from 'node:fs/promises';

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
 * Read one verbatim file's stored bytes in bounded chunks.
 * @param {object} attachments - the composed attachment service.
 * @param {object} ref - durable file reference from the session log.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<Uint8Array>} exact stored bytes.
 */
async function readFileBytes(attachments, ref, signal) {
  const hostPath = typeof attachments.fileHostPath === 'function' ? attachments.fileHostPath(ref) : undefined;
  if (typeof hostPath === 'string' && hostPath !== '') return new Uint8Array(await readFile(hostPath));
  const chunks = [];
  for await (const chunk of attachments.readFileStream(ref, signal)) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Build the archive entries that carry one session's referenced attachments.
 * Unreadable attachments degrade to a warning instead of failing the export.
 * @param {object | undefined} attachments - the composed attachment service.
 * @param {{images: Map<string, object>, files: Map<string, object>}} refs - collected references.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{entries: Array<{name: string, data: Uint8Array}>, warnings: string[]}>} archive entries.
 */
export async function collectAttachmentEntries(attachments, refs, signal) {
  const entries = [];
  const warnings = [];
  if (attachments === undefined) {
    if (refs.images.size + refs.files.size > 0) warnings.push('会话引用了附件，但当前未挂载附件服务，附件不会被导出');
    return { entries, warnings };
  }
  for (const ref of refs.images.values()) {
    try {
      entries.push({ name: imageEntryName(ref), data: await readImageBytes(attachments, ref, signal) });
    } catch (error) {
      warnings.push(`图片 ${String(ref.attachmentId)} 读取失败：${errorText(error)}`);
    }
  }
  for (const ref of refs.files.values()) {
    try {
      entries.push({ name: fileEntryName(ref), data: await readFileBytes(attachments, ref, signal) });
    } catch (error) {
      warnings.push(`文件 ${ref.name} 读取失败：${errorText(error)}`);
    }
  }
  return { entries, warnings };
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

/**
 * `dsh-session-port` — Host half.
 *
 * Two thin faces over the same operations in `lib/host.js`:
 *
 *  - the authenticated browser routes the client half calls
 *    (`GET /session-port/export`, `POST /session-port/import`,
 *    `GET /session-port/info`), fenced by the Connection service exactly like
 *    every other plugin-owned route; and
 *  - one agent tool (`session_port`) so a model can export the conversation it
 *    is running in, or import an archive on the user's behalf.
 *
 * The plugin imports no DSH package: `sessionQuery`, `sessionPersistence`,
 * `attachments`, `workspaceRegistry` and `agentPresets` are read off `ctx`
 * through the Cordis service registry, which keeps the bundle dependency-free
 * and installable from a plain workspace directory.
 *
 * @module dsh-session-port
 */

import { SessionPortFormatError } from './lib/format.js';
import {
  DEFAULT_MAX_IMPORT_BYTES,
  defaultExportDirectory,
  detectFormatVersion,
  exportSession,
  importSession,
  readImportFile,
  servicesOf,
  writeExportFile,
} from './lib/host.js';

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-session-port';

/** Services the plugin cannot work without. */
export const inject = ['tools', 'sessionQuery', 'sessionPersistence'];

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/session-port';

/**
 * Cordis entry point.
 * @param {object} ctx - the plugin context.
 * @param {object} [config] - the Loader row's config (all fields optional).
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config);
  registerRoutes(ctx, settings);
  registerTool(ctx, settings);
}

/**
 * Normalize the Loader row config. Unknown keys are ignored rather than
 * rejected, because the Loader injects schema defaults we do not own.
 * @param {unknown} config - raw row config.
 * @returns {{maxImportBytes: number, includeAttachments: boolean, configuredFormatVersion: number | undefined, exportDirectory: string | undefined}} resolved settings.
 */
function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  return {
    maxImportBytes:
      Number.isSafeInteger(raw.maxImportBytes) && raw.maxImportBytes > 0 ? raw.maxImportBytes : DEFAULT_MAX_IMPORT_BYTES,
    includeAttachments: raw.includeAttachments !== false,
    configuredFormatVersion:
      Number.isSafeInteger(raw.sessionFormatVersion) && raw.sessionFormatVersion > 0 ? raw.sessionFormatVersion : undefined,
    exportDirectory:
      typeof raw.exportDirectory === 'string' && raw.exportDirectory.trim() !== ''
        ? raw.exportDirectory.trim()
        : undefined,
  };
}

/**
 * Register the browser routes once the optional web carrier is up.
 *
 * `webServer` and `connection` are optional services: a headless deployment
 * keeps the tool and simply has no browser face. They are also not guaranteed
 * to be initialized when this plugin's own fiber applies during a cold boot —
 * the web carrier initializes asynchronously, so a plain `ctx.get()` at apply
 * time can observe them as absent (this regressed the routes on the first
 * restart after installation). `ctx.inject()` re-runs the registration when
 * both become available instead, and owns its disposal with the plugin.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 */
function registerRoutes(ctx, settings) {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    const connection = webCtx.get('connection');
    if (webServer === undefined || connection === undefined) return;
    webCtx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            dispatchRequest(ctx, settings, connection, req, res).catch((error) => {
              // `dispatchRequest` already answers every expected failure; this is
              // the last resort so a rejection never leaves a socket hanging.
              try {
                sendJson(res, 500, { ok: false, code: 'internal', message: errorText(error) });
              } catch {
                res.destroy();
              }
            });
          },
        }),
      'session-port: browser routes',
    );
  });
}

/**
 * Route one fenced request under the plugin prefix.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object} connection - the Connection service owning the trust fence.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function dispatchRequest(ctx, settings, connection, req, res) {
  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.end();
    return;
  }
  const url = new URL(String(req.url ?? '/'), 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (path === `${ROUTE_PREFIX}/info` && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        sessionFormatVersion: await detectFormatVersion(ctx, settings.configuredFormatVersion),
        capabilities: {
          export: true,
          import: true,
          attachments: servicesOf(ctx).attachments !== undefined,
          tool: 'session_port',
        },
      });
      return;
    }
    if (path === `${ROUTE_PREFIX}/export` && method === 'GET') {
      await handleExport(ctx, settings, url, res);
      return;
    }
    if (path === `${ROUTE_PREFIX}/import` && method === 'POST') {
      await handleImport(ctx, settings, url, req, res);
      return;
    }
    sendJson(res, 404, { ok: false, code: 'not-found', message: `没有这个接口：${method} ${path}` });
  } catch (error) {
    sendJson(res, statusOf(error), { ok: false, code: codeOf(error), message: errorText(error) });
  }
}

/**
 * `GET /session-port/export` — stream one session archive to the browser.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {URL} url - parsed request URL.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleExport(ctx, settings, url, res) {
  const sessionId = url.searchParams.get('sessionId') ?? '';
  const format = url.searchParams.get('format') === 'jsonl' ? 'jsonl' : 'zip';
  const includeAttachments = url.searchParams.get('attachments') !== '0' && settings.includeAttachments;
  const includeDescendants = url.searchParams.get('subagents') !== '0';
  const exported = await exportSession(ctx, { sessionId, format, includeAttachments, includeDescendants });
  res.writeHead(200, {
    'content-type': format === 'jsonl' ? 'application/jsonl; charset=utf-8' : 'application/zip',
    'content-length': String(exported.data.length),
    'content-disposition': 'attachment; filename="session-export.zip"',
    'cache-control': 'no-store',
    // Header values are ASCII only, so the UTF-8 name travels percent-encoded.
    'x-session-port-filename': encodeURIComponent(exported.filename),
    'x-session-port-warnings': encodeURIComponent(JSON.stringify(exported.warnings ?? [])),
    'x-session-port-events': String(exported.eventCount),
  });
  res.end(exported.data);
}

/**
 * `POST /session-port/import` — commit one uploaded archive as a new session.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {URL} url - parsed request URL (carries cwd/workspace/filename hints).
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleImport(ctx, settings, url, req, res) {
  const buffer = await readRequestBody(req, settings.maxImportBytes);
  const result = await importSession(ctx, {
    buffer,
    filename: url.searchParams.get('filename') ?? undefined,
    cwd: url.searchParams.get('cwd') ?? undefined,
    workspaceId: url.searchParams.get('workspaceId') ?? undefined,
    configuredFormatVersion: settings.configuredFormatVersion,
    maxImportBytes: settings.maxImportBytes,
  });
  sendJson(res, 200, { ok: true, ...result });
}

/**
 * Read a bounded request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} cap - maximum accepted byte count.
 * @returns {Promise<Buffer>} the complete body.
 */
async function readRequestBody(req, cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new SessionPortFormatError('too-large', `导入文件超过大小上限（${Math.round(cap / 1024 / 1024)} MiB）`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** HTTP status for one failure code. */
function statusOf(error) {
  const code = codeOf(error);
  if (code === 'unavailable') return 503;
  if (code === 'not-found' || code === 'file-missing') return 404;
  if (code === 'too-large') return 413;
  if (code === 'internal') return 500;
  return 400;
}

/** Stable failure code for one thrown value. */
function codeOf(error) {
  return error instanceof SessionPortFormatError ? error.code : 'internal';
}

/** One-line message of an arbitrary thrown value. */
function errorText(error) {
  if (error instanceof Error) return error.message.split('\n')[0];
  return String(error);
}

/**
 * Register the model-facing tool. The tool performs exactly the operations the
 * browser half performs, through the same functions.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 */
function registerTool(ctx, settings) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.register !== 'function') return;
  ctx.effect(
    () =>
      tools.register({
        name: 'session_port',
        description: [
          'Move one DSH conversation in or out as a session archive.',
          'action=export writes the CURRENT session (committed log plus referenced attachments) to a ZIP under a plugin-owned folder and returns its path.',
          'action=import reads an archive produced by this plugin or by DSH\'s built-in session-log export and creates a NEW session in the current working directory; the user opens it from the session list.',
          'Import never modifies or deletes an existing session.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['export', 'import'],
              description: 'export: save the current session as a ZIP. import: create a new session from a ZIP or JSONL archive.',
            },
            path: {
              type: 'string',
              description: 'Import only: absolute archive path, or a path relative to the current session directory.',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const agent = exec?.agent;
          const sessionId = agent?.session?.id ?? agent?.id;
          if (args?.action === 'export') {
            if (sessionId === undefined || sessionId === null) {
              throw new Error('session_port: 导出需要运行中的会话');
            }
            const written = await writeExportFile(ctx, {
              sessionId: String(sessionId),
              format: 'zip',
              includeAttachments: settings.includeAttachments,
              directory: settings.exportDirectory ?? defaultExportDirectory(),
            });
            return exportToolText(written);
          }
          if (args?.action === 'import') {
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            if (path === '') throw new Error('session_port: import 需要 path 参数（会话压缩包路径）');
            const cwd = await cwdOf(ctx, agent);
            const file = await readImportFile(path, { cwd, maxImportBytes: settings.maxImportBytes });
            const result = await importSession(ctx, {
              buffer: file.buffer,
              filename: file.filename,
              cwd,
              configuredFormatVersion: settings.configuredFormatVersion,
              maxImportBytes: settings.maxImportBytes,
            });
            return importToolText(result);
          }
          throw new Error('session_port: action 必须是 "export" 或 "import"');
        },
      }),
    'session-port: agent tool',
  );
}

/**
 * The calling session's working directory, or the deployment default.
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} agent - the calling agent.
 * @returns {Promise<string>} a directory path.
 */
async function cwdOf(ctx, agent) {
  const headerCwd = agent?.session?.header?.cwd;
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd;
  const fallback = servicesOf(ctx).workingDirectory?.defaultDirectory;
  if (typeof fallback === 'string' && fallback !== '') return fallback;
  return process.cwd();
}

/** Tool result text for one written export. */
function exportToolText(written) {
  const parts = [`${written.eventCount} 条事件`, `${written.attachmentCount} 个附件`];
  if (written.subagentCount > 0) parts.push(`${written.subagentCount} 个子会话`);
  const lines = [`已导出当前会话：${written.path}（${parts.join('，')}）`];
  for (const warning of written.warnings ?? []) lines.push(`注意：${warning}`);
  return lines.join('\n');
}

/** Tool result text for one imported session. */
function importToolText(result) {
  const lines = [
    `已导入为新会话 ${result.sessionId}（${result.eventCount} 条事件，${result.attachmentCount} 个附件）`,
    result.verified === false
      ? '该会话已写入，但当前 DSH 重新打开它时校验失败——请查看下面的说明，并考虑重新导出后再导入。'
      : '该会话已写入并已验证可打开；刷新或重新打开页面即可在侧边栏看到它。',
  ];
  if (result.title !== undefined) lines.push(`会话标题：${result.title}`);
  for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`);
  return lines.join('\n');
}

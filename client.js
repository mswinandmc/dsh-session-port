/**
 * `dsh-session-port` — Client half.
 *
 * One hand-written CommonJS factory registered into the browser module loader
 * (no bundler, no JSX, no TypeScript; the only runtime import is `react`).
 *
 * Surfaces:
 *  - `conversation.session.header.utilities` — an export button on the open
 *    session's header, next to the other session-scoped utilities; it downloads
 *    the archive the Host produces for that session.
 *  - `main` (key `session-port-import`) + `sidebar.panellist` — an "导入会话" row
 *    in the sidebar's global-panel nav, directly below the plugins row, opening
 *    an import page: drop an archive or pick one, watch the upload, then open the
 *    new conversation. The two registrations are one seat: the sidebar row is the
 *    panel's door, and the panel is the row's page.
 *
 * Both surfaces talk to the Host through the authenticated, Connection-fenced
 * `/session-port/*` routes, so they share one implementation with the agent
 * tool and never touch storage directly.
 *
 * @module dsh-session-port/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-port',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'session-port';
    /** Host route prefix owned by the Host half. */
    const ROUTE_PREFIX = '/session-port';
    /** Main-panel id of the import page; the sidebar row reuses it as its list id. */
    const PANEL_ID = 'session-port-import';

    // #region dictionaries
    const zh = {
      'export.title': '导出会话',
      'export.busy': '正在导出…',
      'export.done': '已导出',
      'export.failed': '导出失败',
      'import.title': '导入会话',
      'import.hint': '选择会话压缩包（.zip）或会话日志（.jsonl）',
      'import.busy': '正在导入…',
      'import.done': '已导入，正在打开…',
      'import.failed': '导入失败',
      'import.openFallback': '会话已导入。请在侧边栏会话列表中找到并打开它。',
      'import.panelHint': '把会话压缩包（.zip）或会话日志（.jsonl）拖到这里，或者选择一个文件。',
      'import.choose': '选择文件…',
      'import.dropActive': '松开鼠标即可导入',
      'import.working': '正在导入 {name}…',
      'import.resultTitle': '导入完成',
      'import.resultSession': '新会话：{id}',
      'import.resultCounts': '{events} 条事件 · {attachments} 个附件',
      'import.open': '打开会话',
      'import.another': '再导一个',
      'import.retry': '重新选择',
      'import.note': '与 DSH 自带「下载会话日志」格式互通；导入只会新增会话，绝不覆盖已有会话。',
      'common.dismiss': '关闭',
      'common.note': '注意',
      'error.network': '无法连接 DSH 主机，请确认页面与主机的连接正常后重试。',
      'error.http': '请求失败（HTTP {status}）。',
      'error.empty': '这个文件是空的。',
      'error.unknown': '发生未知错误，请重试。',
    };
    const en = {
      'export.title': 'Export session',
      'export.busy': 'Exporting…',
      'export.done': 'Exported',
      'export.failed': 'Export failed',
      'import.title': 'Import session',
      'import.hint': 'Choose a session archive (.zip) or session log (.jsonl)',
      'import.busy': 'Importing…',
      'import.done': 'Imported. Opening…',
      'import.failed': 'Import failed',
      'import.openFallback': 'The session was imported. Find and open it in the sidebar session list.',
      'import.panelHint': 'Drop a session archive (.zip) or session log (.jsonl) here, or choose a file.',
      'import.choose': 'Choose file…',
      'import.dropActive': 'Release to import',
      'import.working': 'Importing {name}…',
      'import.resultTitle': 'Import complete',
      'import.resultSession': 'New session: {id}',
      'import.resultCounts': '{events} events · {attachments} attachments',
      'import.open': 'Open session',
      'import.another': 'Import another',
      'import.retry': 'Choose again',
      'import.note': 'Interoperable with DSH\'s own session-log export. Import only ever adds a session; it never overwrites one.',
      'common.dismiss': 'Dismiss',
      'common.note': 'Note',
      'error.network': 'Cannot reach the DSH host. Check the page connection and try again.',
      'error.http': 'Request failed (HTTP {status}).',
      'error.empty': 'This file is empty.',
      'error.unknown': 'Something went wrong. Please try again.',
    };
    // #endregion

    // #region theme tokens
    // Only host theme tokens: the buttons, the popover and the import panel follow
    // light/dark switching without any literal colour.
    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      bgBase: 'var(--dsw-alias-bg-base, Canvas)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1, Canvas)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2, Canvas)',
      border: 'var(--dsw-alias-border-l2)',
      borderL1: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))',
      brand: 'var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))',
      hoverFill: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
      panelFill: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, Canvas))',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary))',
      business: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary))',
      focusRing:
        'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
      radius: 'var(--dsw-radius-sm, 6px)',
      radiusLg: 'var(--dsw-radius-lg, 10px)',
      shadow: 'var(--dsw-shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18))',
      font: 'var(--dsw-font-family, inherit)',
      mono: 'var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace)',
    };
    // #endregion

    // #region icons
    /** Inline square icon; artwork is our own. `size` matches the panel row's request. */
    function Icon({ kind, size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        kind === 'export'
          ? h(
              'g',
              { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M8 2.2v7.4' }),
              h('path', { d: 'M5 6.6 8 9.7l3-3.1' }),
              h('path', { d: 'M3 10.6v2.1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.1' }),
            )
          : h(
              'g',
              { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M8 13.8V6.4' }),
              h('path', { d: 'M5 9.5 8 6.4l3 3.1' }),
              h('path', { d: 'M3 5.4v-2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2' }),
            ),
      );
    }
    // #endregion

    // #region shared helpers

    /** Absolute URL of one Host route on the page's own origin. */
    function hostUrl(path) {
      return new URL(`${ROUTE_PREFIX}${path}`, window.location.href).toString();
    }

    /** A translator that never throws: the slot's `t` prop is the live one, a key echo is the degraded fallback. */
    function translatorOf(t) {
      if (typeof t === 'function') return t;
      try {
        const bound = window.__DSH_LOCALE_BIND__;
        if (typeof bound === 'function') return bound;
      } catch {
        // ignore: the fallback below is always safe.
      }
      return (key) => key;
    }

    /** A short, localizable error description for a thrown request failure. */
    function errorMessageOf(error, t) {
      if (error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code !== '') {
        const message = typeof error.message === 'string' ? error.message.trim() : '';
        if (message !== '') return message;
      }
      if (error !== null && typeof error === 'object' && typeof error.httpStatus === 'number') {
        return t('error.http', { status: error.httpStatus });
      }
      // `fetch` rejects with a TypeError when the Host is unreachable; the other
      // paths below carry real diagnostics and are better than a generic line.
      if (error instanceof TypeError) return t('error.network');
      if (error instanceof Error && error.message.trim() !== '') return error.message.trim();
      return t('error.unknown');
    }

    /** A failure carrying either a Host payload or a transport status. */
    function requestFailure(payload, status) {
      const failure = new Error(
        payload !== null && typeof payload === 'object' && typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${status}`,
      );
      failure.code = payload !== null && typeof payload === 'object' && typeof payload.code === 'string' ? payload.code : '';
      failure.httpStatus = status;
      return failure;
    }

    /** Decode the percent-encoded warnings header; a bad header never fails the export. */
    function warningsOf(response) {
      try {
        const raw = response.headers.get('x-session-port-warnings');
        if (raw === null || raw === '') return [];
        const parsed = JSON.parse(decodeURIComponent(raw));
        return Array.isArray(parsed) ? parsed.filter((line) => typeof line === 'string') : [];
      } catch {
        return [];
      }
    }

    /** Trigger one browser download without navigating away from the app. */
    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    }

    /** The header utility button shape the export action uses. */
    function useIconButton() {
      const [hovered, setHovered] = React.useState(false);
      const [focused, setFocused] = React.useState(false);
      const style = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 28,
        minWidth: 28,
        padding: '0 6px',
        border: 'none',
        borderRadius: T.radius,
        background: hovered ? T.hoverFill : 'transparent',
        color: focused ? T.labelPrimary : T.labelSecondary,
        cursor: 'pointer',
        outline: focused ? T.focusRing : 'none',
        outlineOffset: '-2px',
        font: `13px/20px ${T.font}`,
        whiteSpace: 'nowrap',
      };
      const handlers = {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
      };
      return { style, handlers, hovered };
    }

    /**
     * One anchored status panel. Rendered with fixed positioning inside the
     * component tree (no portal, no DOM writes): the anchor's viewport rect
     * decides the place, and resize/scroll re-measure while it is open.
     */
    function StatusPanel({ anchorRef, open, tone, title, lines, onClose, t }) {
      const tr = translatorOf(t);
      const panelRef = React.useRef(null);
      const [box, setBox] = React.useState(null);
      React.useLayoutEffect(() => {
        if (!open) {
          setBox(null);
          return undefined;
        }
        let frame = 0;
        const measure = () => {
          const anchor = anchorRef.current;
          if (anchor === null) return;
          const rect = anchor.getBoundingClientRect();
          const width = Math.max(220, Math.min(340, window.innerWidth - 24));
          const height = panelRef.current?.offsetHeight ?? 110;
          const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
          const top = rect.top - height - 8 >= 8 ? rect.top - height - 8 : rect.bottom + 8;
          setBox({ left, top, width });
        };
        measure();
        frame = window.requestAnimationFrame(measure);
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
          window.cancelAnimationFrame(frame);
          window.removeEventListener('resize', measure);
          window.removeEventListener('scroll', measure, true);
        };
      }, [open, anchorRef]);
      if (!open) return null;
      const toneColor = tone === 'error' ? T.error : tone === 'success' ? T.success : T.business;
      return h(
        'div',
        {
          ref: panelRef,
          role: 'dialog',
          'aria-label': title,
          style: {
            position: 'fixed',
            left: box === null ? -9999 : box.left,
            top: box === null ? -9999 : box.top,
            width: box === null ? 260 : box.width,
            zIndex: 2147483000,
            boxSizing: 'border-box',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            background: T.panelFill,
            border: `0.5px solid ${T.border}`,
            borderRadius: T.radiusLg,
            boxShadow: T.shadow,
            color: T.labelPrimary,
            font: `13px/20px ${T.font}`,
            pointerEvents: 'auto',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', {
            'aria-hidden': 'true',
            style: { width: 7, height: 7, borderRadius: '50%', background: toneColor, flex: 'none' },
          }),
          h('span', { style: { flex: 1, fontWeight: 600 } }, title),
          h(
            'button',
            {
              type: 'button',
              onClick: onClose,
              'aria-label': tr('common.dismiss'),
              style: {
                border: 'none',
                background: 'transparent',
                color: T.labelTertiary,
                cursor: 'pointer',
                padding: 0,
                font: `16px/16px ${T.font}`,
              },
            },
            '×',
          ),
        ),
        lines.length === 0
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4, color: T.labelSecondary, wordBreak: 'break-word' } },
              lines.map((line, index) => h('div', { key: `${index}-${line.slice(0, 12)}` }, line)),
            ),
      );
    }

    // #endregion

    // #region export surface

    /**
     * Export the open session to a browser download.
     * @param {{sessionId: string, t: Function}} props - session scope props plus dictionary.
     */
    function SessionExportAction({ sessionId, t }) {
      const tr = translatorOf(t);
      const [phase, setPhase] = React.useState('idle');
      const [message, setMessage] = React.useState('');
      const [warnings, setWarnings] = React.useState([]);
      const button = useIconButton();
      const buttonRef = React.useRef(null);
      const [panelOpen, setPanelOpen] = React.useState(false);
      const label = tr('export.title');
      const closePanel = () => setPanelOpen(false);

      async function run() {
        if (phase === 'busy') return;
        setPhase('busy');
        setPanelOpen(false);
        try {
          const response = await fetch(hostUrl(`/export?sessionId=${encodeURIComponent(String(sessionId ?? ''))}`), {
            headers: { accept: 'application/zip' },
          });
          if (!response.ok) {
            let payload = null;
            try {
              payload = await response.json();
            } catch {
              payload = null;
            }
            throw requestFailure(payload, response.status);
          }
          const blob = await response.blob();
          const encoded = response.headers.get('x-session-port-filename');
          const filename = encoded === null ? '' : decodeURIComponent(encoded);
          downloadBlob(blob, filename === '' ? `session-${String(sessionId ?? 'export')}.zip` : filename);
          const notes = warningsOf(response);
          setWarnings(notes);
          setPhase('done');
          if (notes.length > 0) {
            setMessage('');
            setPanelOpen(true);
          } else {
            window.setTimeout(() => setPhase((current) => (current === 'done' ? 'idle' : current)), 2200);
          }
        } catch (error) {
          setPhase('error');
          setMessage(errorMessageOf(error, tr));
          setPanelOpen(true);
        }
      }

      const busy = phase === 'busy';
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            title: phase === 'done' ? tr('export.done') : label,
            'aria-label': label,
            'aria-busy': busy ? 'true' : undefined,
            disabled: busy,
            onClick: run,
            ...button.handlers,
            style: { ...button.style, opacity: busy ? 0.6 : 1, cursor: busy ? 'progress' : 'pointer' },
          },
          h(Icon, { kind: 'export' }),
        ),
        h(StatusPanel, {
          anchorRef: buttonRef,
          open: panelOpen,
          tone: phase === 'error' ? 'error' : 'success',
          title: phase === 'error' ? tr('export.failed') : tr('export.done'),
          lines:
            phase === 'error'
              ? [message]
              : warnings.map((warning) => `${tr('common.note')}：${warning}`),
          onClose: closePanel,
          t,
        }),
      );
    }
    // #endregion

    // #region import panel

    /**
     * Import one archive in the main column: drop a file or browse for one, then
     * reveal the new session. This page is the owner of the sidebar "导入会话"
     * row, registered as the main-slot key `session-port-import`.
     * @param {{t: Function, importArchive: Function, openImported: Function}} props - slot props plus injected operations.
     */
    function SessionImportPanel({ t, importArchive, openImported }) {
      const tr = translatorOf(t);
      const [phase, setPhase] = React.useState('idle');
      const [dragging, setDragging] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const [filename, setFilename] = React.useState('');
      const [warnings, setWarnings] = React.useState([]);
      const [result, setResult] = React.useState(null);
      const [opening, setOpening] = React.useState(false);
      const inputRef = React.useRef(null);
      const busy = phase === 'busy';

      function pick() {
        if (busy) return;
        inputRef.current?.click();
      }

      async function accept(file) {
        if (busy || file === undefined || file === null) return;
        if (file.size === 0) {
          setPhase('error');
          setMessage(tr('error.empty'));
          return;
        }
        setFilename(file.name ?? '');
        setWarnings([]);
        setResult(null);
        setMessage('');
        setOpening(false);
        setPhase('busy');
        try {
          const payload = await importArchive(file);
          setResult(payload ?? null);
          setWarnings(Array.isArray(payload?.warnings) ? payload.warnings : []);
          setPhase('done');
        } catch (error) {
          setPhase('error');
          setMessage(errorMessageOf(error, tr));
        }
      }

      async function openResult() {
        const sessionId = result?.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '' || opening) return;
        setOpening(true);
        setMessage('');
        try {
          await openImported(sessionId);
        } catch (error) {
          console.warn('session-port: imported session could not be opened:', error);
          setMessage(tr('import.openFallback'));
          setOpening(false);
        }
      }

      /** Accept a drag anywhere over the page, not only over the dashed zone. */
      function onDragOver(event) {
        event.preventDefault();
        if (busy) return;
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }

      function onDragLeave(event) {
        const next = event.relatedTarget;
        if (next !== null && next !== undefined && event.currentTarget.contains(next)) return;
        setDragging(false);
      }

      function onDrop(event) {
        event.preventDefault();
        setDragging(false);
        if (busy) return;
        void accept(event.dataTransfer?.files?.[0]);
      }

      function onFiles(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        void accept(file);
      }

      function reset() {
        setPhase('idle');
        setFilename('');
        setMessage('');
        setWarnings([]);
        setResult(null);
        setOpening(false);
      }

      const primaryButton = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 32,
        padding: '0 14px',
        border: 'none',
        borderRadius: T.radius,
        background: T.brand,
        color: T.bgBase,
        font: `500 13px/20px ${T.font}`,
        cursor: 'pointer',
      };
      const secondaryButton = {
        ...primaryButton,
        background: T.bgLayer2,
        color: T.labelPrimary,
        border: `1px solid ${T.border}`,
      };
      const cardOf = (tone) => ({
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '14px 16px',
        border: `1px solid ${T.border}`,
        borderLeft: `3px solid ${tone}`,
        borderRadius: T.radiusLg,
        background: T.bgLayer1,
      });
      const tone = phase === 'error' ? T.error : T.success;
      const zoneHeadline = dragging
        ? tr('import.dropActive')
        : busy
          ? tr('import.working', { name: filename })
          : tr('import.choose');

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            background: T.bgBase,
            color: T.labelPrimary,
            font: `14px/22px ${T.font}`,
          },
          onDragOver,
          onDragLeave,
          onDrop,
        },
        h(
          'div',
          {
            style: {
              maxWidth: 720,
              margin: '0 auto',
              padding: '32px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            },
          },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('h1', { style: { margin: 0, font: `600 20px/28px ${T.font}` } }, tr('import.title')),
            h('p', { style: { margin: 0, font: `13px/20px ${T.font}`, color: T.labelSecondary } }, tr('import.panelHint')),
          ),
          h(
            'div',
            {
              role: 'button',
              tabIndex: busy ? -1 : 0,
              'aria-label': tr('import.choose'),
              'aria-busy': busy ? 'true' : undefined,
              'data-session-port-import': 'zone',
              onClick: pick,
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                pick();
              },
              style: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 12,
                padding: '32px 20px',
                border: `1.5px dashed ${dragging ? T.brand : T.border}`,
                borderRadius: T.radiusLg,
                background: dragging ? T.bgLayer2 : T.bgLayer1,
                textAlign: 'center',
                cursor: busy ? 'progress' : 'pointer',
                transition: 'border-color 120ms ease, background 120ms ease',
              },
            },
            h(
              'span',
              {
                'aria-hidden': 'true',
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: T.bgLayer2,
                  color: dragging ? T.brand : T.labelSecondary,
                },
              },
              h(Icon, { kind: 'import', size: 22 }),
            ),
            h('span', { style: { font: `600 14px/22px ${T.font}`, color: T.labelPrimary } }, zoneHeadline),
            h('span', { style: { font: `12px/18px ${T.font}`, color: T.labelSecondary } }, tr('import.hint')),
          ),
          h('input', {
            ref: inputRef,
            type: 'file',
            accept: '.zip,.jsonl,application/zip,application/jsonl,application/x-ndjson',
            style: { display: 'none' },
            onChange: onFiles,
            'aria-hidden': 'true',
            tabIndex: -1,
          }),
          phase === 'error'
            ? h(
                'div',
                { role: 'alert', style: cardOf(tone) },
                h('span', { style: { font: `600 13px/20px ${T.font}`, color: T.labelPrimary } }, tr('import.failed')),
                h('span', { style: { font: `13px/20px ${T.font}`, color: T.labelSecondary } }, message),
                h(
                  'span',
                  { style: { display: 'flex', gap: 8, marginTop: 4 } },
                  h('button', { type: 'button', onClick: pick, style: primaryButton }, tr('import.retry')),
                ),
              )
            : null,
          phase === 'done'
            ? h(
                'div',
                { role: 'status', style: cardOf(tone) },
                h(
                  'span',
                  { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h('span', {
                    'aria-hidden': 'true',
                    style: { width: 8, height: 8, borderRadius: '50%', background: T.success, flex: 'none' },
                  }),
                  h('span', { style: { font: `600 13px/20px ${T.font}`, color: T.labelPrimary } }, tr('import.resultTitle')),
                ),
                typeof result?.title === 'string' && result.title !== ''
                  ? h('span', { style: { font: `13px/20px ${T.font}`, color: T.labelPrimary } }, result.title)
                  : null,
                h(
                  'span',
                  { style: { font: `12px/18px ${T.mono}`, color: T.labelSecondary, wordBreak: 'break-all' } },
                  tr('import.resultSession', { id: String(result?.sessionId ?? '') }),
                ),
                h(
                  'span',
                  { style: { font: `12px/18px ${T.font}`, color: T.labelSecondary } },
                  tr('import.resultCounts', {
                    events: String(result?.eventCount ?? 0),
                    attachments: String(result?.attachmentCount ?? 0),
                  }),
                ),
                ...warnings.map((warning, index) =>
                  h(
                    'span',
                    { key: `${index}-${warning.slice(0, 12)}`, style: { font: `12px/18px ${T.font}`, color: T.warn } },
                    `${tr('common.note')}：${warning}`,
                  ),
                ),
                message !== ''
                  ? h('span', { style: { font: `12px/18px ${T.font}`, color: T.labelSecondary } }, message)
                  : null,
                h(
                  'span',
                  { style: { display: 'flex', gap: 8, marginTop: 4 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: openResult,
                      disabled: opening || result?.sessionId === undefined,
                      style: { ...primaryButton, opacity: opening ? 0.6 : 1, cursor: opening ? 'progress' : 'pointer' },
                    },
                    opening ? tr('import.busy') : tr('import.open'),
                  ),
                  h('button', { type: 'button', onClick: reset, style: secondaryButton }, tr('import.another')),
                ),
              )
            : null,
          h('p', { style: { margin: 0, font: `12px/18px ${T.font}`, color: T.labelSecondary } }, tr('import.note')),
        ),
      );
    }
    // #endregion

    // #region host calls

    /** The working directory and workspace an import should join. */
    function importTargetOf(ctx) {
      try {
        const selection = ctx.get('uiWorkspace')?.selection?.getSnapshot?.() ?? {};
        const currentId = typeof selection.sessionId === 'string' ? selection.sessionId : undefined;
        const sessions = ctx.get('sessions')?.list?.getSnapshot?.();
        const workspaceList = ctx.get('workspaces')?.list?.getSnapshot?.();
        const items = Array.isArray(workspaceList?.items) ? workspaceList.items : [];
        if (currentId !== undefined) {
          const cwd = sessions?.byId?.[currentId]?.cwd;
          const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(currentId));
          return {
            ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : owner?.path !== undefined ? { cwd: owner.path } : {}),
            ...(owner?.workspaceId !== undefined ? { workspaceId: owner.workspaceId } : {}),
          };
        }
        const first = items.find((item) => typeof item.path === 'string' && item.path !== '');
        return first === undefined ? {} : { cwd: first.path, workspaceId: first.workspaceId };
      } catch {
        return {};
      }
    }

    /** Upload one archive and return the Host's creation result. */
    async function importArchive(ctx, file) {
      const target = importTargetOf(ctx);
      const params = new URLSearchParams();
      params.set('filename', file.name ?? 'session.zip');
      if (typeof target.cwd === 'string' && target.cwd !== '') params.set('cwd', target.cwd);
      if (typeof target.workspaceId === 'string' && target.workspaceId !== '') params.set('workspaceId', target.workspaceId);
      const response = await fetch(hostUrl(`/import?${params.toString()}`), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', accept: 'application/json' },
        body: file,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload === null || payload.ok !== true) throw requestFailure(payload, response.status);
      return payload;
    }

    /** Refresh the session catalog and reveal the imported conversation. */
    async function openImported(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error('import returned no session id');
      const sessions = ctx.get('sessions');
      if (sessions !== undefined && typeof sessions.refresh === 'function') await sessions.refresh();
      const workspace = ctx.get('uiWorkspace');
      if (workspace !== undefined && typeof workspace.openSession === 'function') workspace.openSession(sessionId);
    }
    // #endregion

    // #region plugin body

    /**
     * Client services the two surfaces cannot work without. The session and
     * workspace controllers are read through `ctx.get()` at call time instead
     * of being injected, so a deployment that drops one of those surfaces keeps
     * the buttons loading (they just fall back to the Host default directory).
     */
    const inject = ['slots', 'locale'];

    /**
     * Client plugin body: dictionaries first, then the two registrations. Each
     * registration is guarded so a Host without the slot (or refusing it) keeps
     * the page booting.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-port: dictionaries');
      } catch (error) {
        console.warn('session-port: dictionary registration failed:', error);
      }

      try {
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'session-port-export',
              order: 20,
              locale: NS,
            },
            SessionExportAction,
          ),
        );
      } catch (error) {
        console.warn('session-port: export action registration failed:', error);
      }

      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({
                importArchive: (file) => importArchive(ctx, file),
                openImported: (sessionId) => openImported(ctx, sessionId),
              }),
            },
            SessionImportPanel,
          ),
        );
      } catch (error) {
        console.warn('session-port: import panel registration failed:', error);
      }

      // The sidebar row: one global-panel entry beside 插件 / 日程, ordered
      // directly below the plugins row (order 0) and above schedules (order 10).
      // Its label is a thunk the sidebar re-reads on every projection, so the row
      // follows a live locale switch; without a locale service it falls back to
      // this plugin's own dictionary rather than dropping the row.
      try {
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => zh[key] ?? key;
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 5,
              locale: NS,
              label: () => t('import.title'),
            },
            ({ size }) => h(Icon, { kind: 'import', size: size ?? 16 }),
          ),
        );
      } catch (error) {
        console.warn('session-port: import panel row registration failed:', error);
      }
    }
    // #endregion

    return { inject, apply, name: NS };
  },
});

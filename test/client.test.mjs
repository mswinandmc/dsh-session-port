/**
 * Structural tests for the browser half. They execute the real bundle in a
 * sandbox with a minimal React stand-in and a recording client context, then
 * render both registered components once as plain functions. That catches
 * registration mistakes and render-path exceptions without a browser.
 *
 * Run with: node --test test/client.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** A React stand-in: enough for element construction and hook book-keeping. */
function fakeReact() {
  return {
    createElement: (...args) => ({ kind: 'element', args }),
    Fragment: 'fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (value) => ({ current: value }),
    useLayoutEffect: () => undefined,
    useEffect: () => undefined,
  };
}

/**
 * Load the bundle into a fresh sandbox.
 * @returns {{id: string, factory: Function, loaded: {id: string}}} the registered factory.
 */
function loadBundle() {
  let loaded;
  const window = {
    __ModuleLoader__: {
      load: (descriptor) => {
        loaded = descriptor;
      },
    },
    location: { href: 'http://127.0.0.1:62774/' },
    innerWidth: 1200,
    setTimeout: () => 0,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    console,
  };
  const headChildren = [];
  const document = {
    body: { appendChild: () => undefined },
    head: { appendChild: (node) => { headChildren.push(node); } },
    getElementById: (id) => headChildren.find((node) => node.id === id) ?? null,
    createElement: () => ({ style: {}, click: () => undefined, remove: () => undefined }),
  };
  const sandbox = {
    window,
    document,
    console,
    URL,
    URLSearchParams,
    fetch: async () => {
      throw new Error('network disabled in this test');
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.ok(loaded !== undefined, 'the bundle must call __ModuleLoader__.load');
  return { loaded, sandbox, headChildren };
}

/** A recording client context with the two services the bundle injects. */
function fakeContext() {
  const dictionaries = [];
  const registrations = [];
  const injections = [];
  const ctx = {
    effect: (factory) => {
      const disposer = factory();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    locale: {
      register: (namespace, dicts) => {
        dictionaries.push({ namespace, dicts });
        return () => undefined;
      },
    },
    slots: {
      inject: (name, callback) => {
        injections.push(name);
        const disposer = callback();
        return () => {
          if (typeof disposer === 'function') disposer();
        };
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => undefined;
      },
    },
    get: () => undefined,
  };
  return { ctx, dictionaries, registrations, injections };
}

test('bundle id and inject list match the package contract', () => {
  const { loaded } = loadBundle();
  assert.equal(loaded.id, 'dsh-session-port');
  const plugin = loaded.factory((name) => {
    if (name === 'react') return fakeReact();
    throw new Error(`unexpected require: ${name}`);
  });
  // The bundle runs in a vm realm, so compare the element values, not identity.
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply registers the dictionaries, the export action, and the import row', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, dictionaries, registrations, injections } = fakeContext();
  plugin.apply(ctx);

  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].namespace, 'session-port');
  assert.ok(Object.keys(dictionaries[0].dicts.zh).length > 5, 'zh dictionary has entries');
  assert.deepEqual(Object.keys(dictionaries[0].dicts.zh), Object.keys(dictionaries[0].dicts.en));

  assert.deepEqual(injections, ['conversation.session.header.utilities', 'main', 'sidebar.panellist']);
  assert.equal(registrations.length, 3);

  const exportEntry = registrations.find((entry) => entry.options.id === 'session-port-export');
  assert.ok(exportEntry !== undefined, 'export entry registered');
  assert.equal(exportEntry.options.name, 'conversation.session.header.utilities');
  assert.equal(exportEntry.options.locale, 'session-port');

  const panelEntry = registrations.find((entry) => entry.options.name === 'main');
  assert.ok(panelEntry !== undefined, 'import panel registered');
  assert.equal(panelEntry.options.key, 'session-port-import');
  assert.equal(panelEntry.options.locale, 'session-port');
  assert.equal(typeof panelEntry.options.inject, 'function');
  const injected = panelEntry.options.inject();
  assert.equal(typeof injected.importArchive, 'function');
  assert.equal(typeof injected.undoImport, 'function');
  assert.equal(typeof injected.listImports, 'function');
  assert.equal(typeof injected.openImported, 'function');

  const rowEntry = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  assert.ok(rowEntry !== undefined, 'sidebar row registered');
  assert.equal(rowEntry.options.id, 'session-port-import');
  assert.equal(rowEntry.options.order, 5, 'the row sits between 插件 (0) and 日程 (10)');
  assert.equal(rowEntry.options.locale, 'session-port');
  assert.equal(rowEntry.options.label(), '导入会话', 'row label falls back to the bundle dictionary');

  // The footer seat is gone: the sidebar row is the panel's only door.
  assert.equal(registrations.some((entry) => entry.options.name === 'sidebar.footer.action'), false);
});

test('the export component renders a labelled button without throwing', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const exportEntry = registrations.find((entry) => entry.options.id === 'session-port-export');
  const t = (key) => `t:${key}`;
  const element = exportEntry.component({ sessionId: 'session-demo', t });
  assert.equal(element.kind, 'element');
  assert.equal(element.args[0], 'fragment');
  const button = element.args[2];
  assert.equal(button.kind, 'element');
  assert.equal(button.args[0], 'button');
  assert.equal(button.args[1].title, 't:export.title');
  assert.equal(button.args[1]['aria-label'], 't:export.title');
  assert.equal(typeof button.args[1].onClick, 'function');
});

/** Collect every string and every element inside one fake-React tree. */
function walk(node, hits = { strings: [], elements: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return hits;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, hits);
    return hits;
  }
  if (typeof node === 'string') {
    hits.strings.push(node);
    return hits;
  }
  if (typeof node === 'object' && node.kind === 'element') {
    hits.elements.push(node);
    for (const child of node.args.slice(2)) walk(child, hits);
  }
  return hits;
}

test('the import panel renders a drop zone, a hidden input, and localized copy', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const panelEntry = registrations.find((entry) => entry.options.name === 'main');
  const t = (key) => `t:${key}`;
  const element = panelEntry.component({ t, importArchive: async () => ({}), openImported: async () => {} });
  assert.equal(element.kind, 'element');

  const { strings, elements } = walk(element);
  assert.ok(strings.includes('t:import.title'), 'panel title');
  assert.ok(strings.includes('t:import.panelHint'), 'panel hint');
  assert.ok(strings.includes('t:import.choose'), 'choose-file headline');

  const input = elements.find((node) => node.args[0] === 'input');
  assert.ok(input !== undefined, 'hidden file input present');
  assert.equal(input.args[1].type, 'file');
  assert.equal(input.args[1].accept.includes('.zip'), true);
  assert.equal(input.args[1].style.display, 'none');
  assert.equal(typeof input.args[1].onChange, 'function');

  const zone = elements.find((node) => node.args[1]?.['data-session-port-import'] === 'zone');
  assert.ok(zone !== undefined, 'drop zone present');
  assert.equal(zone.args[1].role, 'button');
  assert.equal(zone.args[1].tabIndex, 0);
  assert.equal(typeof zone.args[1].onClick, 'function');
  assert.equal(typeof zone.args[1].onKeyDown, 'function');
});

test('the picker preselects nothing and blocks import until a workspace is chosen', async () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const panelEntry = registrations.find((entry) => entry.options.name === 'main');
  const t = (key) => `t:${key}`;

  const workspaces = [
    { workspaceId: 'w3', path: '/srv/z', title: 'zulu' },
    { workspaceId: 'w1', path: '/srv/b', title: 'beta' },
    { workspaceId: 'w2', path: '/srv/a', title: 'Alpha' },
  ];
  let captured;
  const importArchive = async (file, target) => {
    captured = { file, target };
    return { sessionId: 'session-x', eventCount: 1 };
  };

  const element = panelEntry.component({
    t,
    importArchive,
    undoImport: async () => ({}),
    listImports: async () => [],
    openImported: async () => {},
    workspaces,
  });

  const { strings, elements } = walk(element);
  assert.ok(strings.includes('t:import.workspace'), 'workspace label present');
  const group = elements.find((node) => node.args[1]?.role === 'radiogroup');
  assert.ok(group !== undefined, 'workspace radiogroup rendered for multiple workspaces');
  assert.equal(group.args[1].style.maxHeight, 240, 'list height is capped');
  assert.equal(group.args[1].style.overflowY, 'auto', 'list scrolls when overflowing');
  const rows = elements.filter((node) => node.args[1]?.role === 'radio');
  assert.equal(rows.length, 3, 'one row per workspace');
  assert.ok(
    strings.indexOf('Alpha') < strings.indexOf('beta') && strings.indexOf('beta') < strings.indexOf('zulu'),
    'rows are in case-insensitive name order regardless of input order',
  );
  assert.ok(
    rows.every((row) => row.args[1]['aria-checked'] === 'false'),
    'nothing is preselected among several workspaces',
  );
  assert.equal(typeof rows[2].args[1].onClick, 'function');
  assert.ok(strings.includes('/srv/a'), 'titled workspace shows its path as the secondary line');
  assert.ok(strings.includes('/srv/z'), 'every workspace path is shown');

  // Without an explicit choice the import is refused, not inferred.
  const input = elements.find((node) => node.args[0] === 'input');
  input.args[1].onChange({ target: { files: [{ name: 'a.zip', size: 16 }], value: 'x' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(captured, undefined, 'import does not run without an explicit choice');

  // Once a workspace is chosen, that exact target reaches importArchive.
  const chosen = panelEntry.component({
    t,
    importArchive,
    undoImport: async () => ({}),
    listImports: async () => [],
    openImported: async () => {},
    workspaces,
    initialTarget: { cwd: '/srv/b', workspaceId: 'w1' },
  });
  const chosenRows = walk(chosen).elements.filter((node) => node.args[1]?.role === 'radio');
  assert.equal(chosenRows[1].args[1]['aria-checked'], 'true', 'the chosen row is selected');
  const chosenInput = walk(chosen).elements.find((node) => node.args[0] === 'input');
  chosenInput.args[1].onChange({ target: { files: [{ name: 'a.zip', size: 16 }], value: 'x' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(captured !== undefined, 'import runs once a workspace is chosen');
  assert.deepEqual(captured.target, { cwd: '/srv/b', workspaceId: 'w1' });
});

test('a single workspace preselects itself; none hides the picker', async () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const panelEntry = registrations.find((entry) => entry.options.name === 'main');
  const t = (key) => `t:${key}`;

  let captured;
  const element = panelEntry.component({
    t,
    importArchive: async (file, target) => {
      captured = { target };
      return { sessionId: 'session-x', eventCount: 1 };
    },
    undoImport: async () => ({}),
    listImports: async () => [],
    openImported: async () => {},
    workspaces: [{ workspaceId: 'w1', path: '/srv/only', title: 'Only' }],
  });
  const { elements } = walk(element);
  const rows = elements.filter((node) => node.args[1]?.role === 'radio');
  assert.equal(rows.length, 1, 'the single workspace is listed');
  assert.equal(rows[0].args[1]['aria-checked'], 'true', 'the only choice preselects itself');
  const input = elements.find((node) => node.args[0] === 'input');
  input.args[1].onChange({ target: { files: [{ name: 'a.zip', size: 16 }], value: 'x' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(captured.target.cwd, '/srv/only', 'the only workspace is the import target');
  assert.equal(captured.target.workspaceId, 'w1');

  const bare = panelEntry.component({
    t,
    importArchive: async () => ({}),
    undoImport: async () => ({}),
    listImports: async () => [],
    openImported: async () => {},
    workspaces: [],
  });
  assert.equal(
    walk(bare).elements.some((node) => node.args[1]?.role === 'radiogroup'),
    false,
    'no picker without any workspace',
  );
});

test('apply injects the spinner keyframes style exactly once', () => {
  const { loaded, headChildren } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  plugin.apply(fakeContext().ctx);
  plugin.apply(fakeContext().ctx);
  const styles = headChildren.filter((node) => node.id === 'session-port-style');
  assert.equal(styles.length, 1, 'style injected exactly once across applies');
  const text = String(styles[0].textContent);
  assert.ok(text.includes('@keyframes session-port-spin'), 'spin keyframes present');
  assert.ok(text.includes('prefers-reduced-motion'), 'reduced-motion override present');
});

test('the import panel lists past imports with an undo button per row', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const panelEntry = registrations.find((entry) => entry.options.name === 'main');
  const t = (key, params) => (params === undefined ? `t:${key}` : `t:${key}:${JSON.stringify(params)}`);

  const element = panelEntry.component({
    t,
    importArchive: async () => ({}),
    undoImport: async () => ({ ok: true }),
    listImports: async () => [],
    openImported: async () => {},
    initialHistory: [
      { sessionId: 'session-x', title: '研究', importedAt: 2, eventCount: 5 },
      { sessionId: 'session-y', importedAt: 1, eventCount: 3 },
      { sessionId: 'session-z', importedAt: 3, eventCount: 1, pendingUndo: true },
    ],
  });
  const { strings, elements } = walk(element);
  assert.ok(strings.includes('t:import.history'), 'history header present');
  assert.ok(strings.includes('研究'), 'titled row shows the title');
  assert.ok(strings.includes('session-y'), 'untitled row falls back to the session id');
  assert.ok(strings.some((text) => String(text).includes('"events":5')), 'meta line carries the event count');
  const undoButtons = elements
    .filter((node) => node.args[0] === 'button')
    .filter((node) => node.args[2] === 't:import.undo');
  assert.equal(undoButtons.length, 2, 'one undo button per open history row');
  assert.equal(typeof undoButtons[0].args[1].onClick, 'function');
  const queuedButton = elements
    .filter((node) => node.args[0] === 'button')
    .find((node) => node.args[2] === 't:import.undoPending');
  assert.ok(queuedButton !== undefined, 'a queued row shows its waiting state');
  assert.equal(queuedButton.args[1].disabled, true, 'a queued row cannot be re-clicked');

  const plain = panelEntry.component({
    t,
    importArchive: async () => ({}),
    undoImport: async () => ({}),
    listImports: async () => [],
    openImported: async () => {},
  });
  const plainHits = walk(plain);
  assert.ok(plainHits.strings.includes('t:import.historyEmpty'), 'empty history explains itself');
  assert.equal(
    plainHits.elements.some(
      (node) => node.args[0] === 'button' && node.args[2] === 't:import.undo',
    ),
    false,
    'no undo buttons without history',
  );
});

test('the sidebar row renders the requested square glyph', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const rowEntry = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  // The row owns a component, so the fake renderer stops at the Icon element and
  // the icon is invoked explicitly with the row's presentation props.
  const glyph = rowEntry.component({ size: 18, active: true });
  assert.equal(typeof glyph.args[0], 'function', 'row renders the shared Icon component');
  assert.equal(glyph.args[1].size, 18);
  assert.equal(glyph.args[1].kind, 'import');
  const svg = glyph.args[0](glyph.args[1]);
  assert.equal(svg.args[0], 'svg');
  assert.equal(svg.args[1].width, 18);
  assert.equal(svg.args[1]['aria-hidden'], 'true');
});

test('the export component defaults its translator instead of crashing', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const exportEntry = registrations.find((entry) => entry.options.id === 'session-port-export');
  const element = exportEntry.component({ sessionId: 'session-demo' });
  const button = element.args[2];
  assert.equal(button.args[1]['aria-label'], 'export.title');
});

test('registration failures are swallowed so the page keeps booting', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const broken = {
    effect: (factory) => factory(),
    locale: {
      register: () => {
        throw new Error('locale down');
      },
    },
    slots: {
      inject: () => {
        throw new Error('no such slot');
      },
    },
    get: () => undefined,
  };
  assert.doesNotThrow(() => plugin.apply(broken));
});

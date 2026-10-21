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
  const document = {
    body: { appendChild: () => undefined },
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
  return { loaded, sandbox };
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

test('apply registers the dictionaries and both slot entries', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, dictionaries, registrations, injections } = fakeContext();
  plugin.apply(ctx);

  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].namespace, 'session-port');
  assert.ok(Object.keys(dictionaries[0].dicts.zh).length > 5, 'zh dictionary has entries');
  assert.deepEqual(Object.keys(dictionaries[0].dicts.zh), Object.keys(dictionaries[0].dicts.en));

  assert.deepEqual(injections, ['conversation.session.header.utilities', 'sidebar.footer.action']);
  assert.equal(registrations.length, 2);
  const exportEntry = registrations.find((entry) => entry.options.id === 'session-port-export');
  const importEntry = registrations.find((entry) => entry.options.id === 'session-port-import');
  assert.ok(exportEntry !== undefined, 'export entry registered');
  assert.equal(exportEntry.options.name, 'conversation.session.header.utilities');
  assert.equal(exportEntry.options.locale, 'session-port');
  assert.ok(importEntry !== undefined, 'import entry registered');
  assert.equal(importEntry.options.name, 'sidebar.footer.action');
  assert.equal(importEntry.options.locale, 'session-port');
  assert.equal(typeof importEntry.options.inject, 'function');
  const injected = importEntry.options.inject();
  assert.equal(typeof injected.importArchive, 'function');
  assert.equal(typeof injected.openImported, 'function');
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

test('the import component renders wide and rail shapes, plus its hidden input', () => {
  const { loaded } = loadBundle();
  const plugin = loaded.factory(() => fakeReact());
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const importEntry = registrations.find((entry) => entry.options.id === 'session-port-import');
  const injected = importEntry.options.inject();
  const t = (key) => `t:${key}`;

  const wide = importEntry.component({ wide: true, t, ...injected });
  assert.equal(wide.kind, 'element');
  const button = wide.args[2];
  const input = wide.args[3];
  assert.equal(button.args[1].style.width, '100%');
  // The wide footer shows the localized label beside the icon.
  assert.equal(button.args[3].kind, 'element', 'label element present in wide mode');
  assert.equal(button.args[3].args[0], 'span');
  assert.equal(input.args[0], 'input');
  assert.equal(input.args[1].type, 'file');
  assert.equal(input.args[1].accept.includes('.zip'), true);
  assert.equal(typeof input.args[1].onChange, 'function');

  const rail = importEntry.component({ wide: false, t, ...injected });
  const railButton = rail.args[2];
  assert.equal(railButton.args[1].style.width, undefined);
  assert.equal(railButton.args[3], null, 'no label in rail mode');
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

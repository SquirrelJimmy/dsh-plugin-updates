/**
 * Regression test for the two reported UI defects, run against the REAL built bundle.
 *
 *  1. 升级后切走再回来，行里还显示旧版本 + 「可升级」 —— 缓存里的 check.installed
 *     覆盖了宿主实时的 bundle.version。
 *  2. 某行正在升级时，其它行不该被标成「本地开发」。
 *
 * Usage: node test/upgrade-state.cjs        (expects dist/client.js to be built)
 */
const path = require('node:path');

const BUNDLE = path.join(__dirname, '..', 'dist', 'client.js');

// ------------------------------------------------------------------ mini react
let hooks = [];
let cursor = 0;
let pending = null;
let effects = [];

function createElement(type, props, ...children) {
  const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
  return { type, props: { ...(props ?? {}), children: kids } };
}

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

const React = {
  createElement,
  useState(init) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
    return [hooks[i], (next) => {
      const value = typeof next === 'function' ? next(hooks[i]) : next;
      if (Object.is(value, hooks[i])) return;
      hooks[i] = value;
      if (pending) pending();
    }];
  },
  useRef(init) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = { current: init };
    return hooks[i];
  },
  useMemo(fn, deps) {
    const i = cursor++;
    const prev = hooks[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    const value = fn();
    hooks[i] = { value, deps };
    return value;
  },
  useCallback(fn, deps) {
    const i = cursor++;
    const prev = hooks[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    hooks[i] = { value: fn, deps };
    return fn;
  },
  useEffect(fn, deps) {
    const i = cursor++;
    const prev = hooks[i];
    if (prev && deps !== undefined && sameDeps(prev.deps, deps)) return;
    hooks[i] = { deps };
    effects.push(fn);
  },
};

// ---------------------------------------------------------------- fake browser
const BUNDLES = [
  // Already upgraded to 0.6.3, but the cache below still remembers 0.5.3.
  { name: 'better-dsh-session-deletetool', version: '0.6.3', installed: true, enabled: true, official: false, removable: true, source: 'better-dsh-session-deletetool@0.6.3' },
  { name: 'billion-context', version: '0.1.211', installed: true, enabled: true, official: false, removable: true, source: 'billion-context@0.1.211' },
  // Genuinely outdated: cache agrees with the profile, registry has 0.2.0.
  { name: 'dsh-context', version: '0.79.0', installed: true, enabled: true, official: false, removable: true, source: 'dsh-context@0.79.0' },
  { name: '@deepseek-ai/dsh-better-sidebar', version: '0.2.1-rc.5', installed: true, enabled: true, official: true, removable: false },
  { name: 'dsh-preset-codex', version: '0.1.0', installed: true, enabled: true, official: false, removable: true, source: 'link:/volume5/x/dsh-preset-codex' },
];

const CACHE = {
  at: new Date(Date.now() - 60_000).toISOString(),
  results: {
    'better-dsh-session-deletetool': { ok: true, installed: '0.5.3', latest: '0.6.3' },
    'billion-context': { ok: true, installed: '0.1.211', latest: '0.1.211' },
    'dsh-context': { ok: true, installed: '0.79.0', latest: '0.80.0' },
  },
};

const store = { 'dsh-plugin-updates:check:v1': JSON.stringify(CACHE) };
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
};
global.window = {
  __ModuleLoader__: { load: (spec) => { captured = spec; } },
  localStorage: global.localStorage,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  location: { reload() {} },
};
global.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  head: { appendChild() {} },
  createElement: () => ({ textContent: '', style: {}, setAttribute() {}, remove() {}, parentNode: null }),
  getElementById: () => null,
};
global.navigator = { language: 'zh-CN', clipboard: { writeText: async () => {} } };
global.fetch = async (url) => {
  if (String(url).includes('/plugin-updates/state')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          host: { version: '0.7.1', runtimeVersion: '0.2.1-rc.5', policy: { minutes: 1440, explicit: true } },
          queue: { pending: 0, items: [] },
          lastRun: null,
          nonce: 'test',
        };
      },
    };
  }
  return { ok: false, status: 404, async json() { return {}; } };
};

let captured = null;
require(BUNDLE);
const mod = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
});

const pm = {
  async listBundles() { return { ok: true, value: BUNDLES }; },
  async installBundle() { return new Promise(() => {}); }, // stays "in flight" on purpose
  async removeBundle() { return new Promise(() => {}); },
  async waitForInstall() { return { ok: false }; },
  async setBundleEnabled() { return { ok: true, value: {} }; },
};

const ctx = {
  effect(fn) { fn(); return () => {}; },
  on() { return () => {}; },
  get() { return undefined; },
  slots: { inject(_n, fn) { fn(); }, register(spec, component) { ctx._reg = { spec, component }; return () => {}; } },
  locale: { register() {}, bind: () => (key) => key, getLocale: () => ({ active: 'zh' }) },
  remote: { pluginManager: pm, $on() { return () => {}; } },
};

mod.apply(ctx);
const Section = ctx._reg.component;

// ---------------------------------------------------------------- render loop
let tree = null;
let scheduled = false;

function render() {
  cursor = 0;
  effects = [];
  tree = Section({});
  const run = effects;
  effects = [];
  for (const fn of run) fn();
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; render(); });
}
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 5));
  render();
};

function expand(node) {
  if (node === null || node === undefined || node === false) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node === 'object' && typeof node.type === 'function' && node.type !== Section) return expand(node.type(node.props ?? {}));
  return node;
}
function textOf(node) {
  const value = expand(node);
  if (value === null || value === undefined || value === false) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  return value.props ? textOf(value.props.children) : '';
}
function byClass(node, cls, out = []) {
  node = expand(node);
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => byClass(n, cls, out)); return out; }
  const cn = node.props?.className;
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) out.push(node);
  byClass(node.props?.children, cls, out);
  return out;
}

const rows = () => byClass(tree, 'pu-row').map((row) => ({
  name: byClass(row, 'pu-pkg')[0]?.props?.title ?? '',
  installed: textOf(byClass(row, 'pu-ver')[0]).trim(),
  next: textOf(byClass(row, 'pu-vercell')[0]).trim(),
  badge: textOf(byClass(row, 'pu-badge')[0]).trim(),
  action: textOf(byClass(row, 'pu-actions')[0]).trim(),
}));

const failures = [];
function check(label, actual, expected) {
  if (actual === expected) return;
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

(async () => {
  pending = schedule;
  render();
  await flush();

  const stale = rows().find((r) => r.name === 'better-dsh-session-deletetool');
  // The profile says 0.6.3; the cached check said 0.5.3. The live value must win.
  check('stale row current version', stale.installed, '0.6.3');
  check('stale row must not offer an upgrade', stale.next, '—');
  check('stale row action', stale.action, '检测更新');

  const outdated = rows().find((r) => r.name === 'dsh-context');
  check('outdated row current version', outdated.installed, '0.79.0');
  check('outdated row target', outdated.next, '0.80.0');
  check('outdated row action', outdated.action, '升级');

  // Start that upgrade, then look at every other row.
  const upgrade = byClass(tree, 'pu-btn').find((b) => textOf(b) === '升级');
  if (!upgrade) throw new Error('no upgrade button to click');
  upgrade.props.onClick();
  await flush();

  const during = rows();
  const busy = during.find((r) => r.name === 'dsh-context');
  check('busy row action', busy.action, '升级中…');
  for (const row of during) {
    if (row.name === 'dsh-context') continue;
    if (row.badge === '本地开发' && row.name !== 'dsh-preset-codex') {
      failures.push(`row ${row.name} became 本地开发 while another row was upgrading`);
    }
  }
  check('unrelated row stays 已最新', during.find((r) => r.name === 'billion-context').badge, '已最新');
  check('linked package stays 本地开发', during.find((r) => r.name === 'dsh-preset-codex').badge, '本地开发');

  if (failures.length > 0) {
    console.error('FAIL');
    for (const line of failures) console.error(` - ${line}`);
    process.exit(1);
  }
  console.log('OK — stale check dropped, live version wins, no row mislabelled during an upgrade');
  process.exit(0);
})().catch((error) => { console.error('FAILED', error); process.exit(1); });

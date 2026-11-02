/**
 * Host half of dsh-plugin-updates.
 *
 * Responsibilities (deliberately small, zero dependencies):
 *  - expose a few same-origin HTTP routes under /plugin-updates for the client tab
 *  - keep a small on-disk queue so an upgrade that needs a process restart can be
 *    finished automatically after the process comes back
 *  - restart the DSH process on explicit request through whatever supervises it
 *
 * It never touches pnpm directly: every install/remove goes through the built-in
 * `pluginManager` service, which owns the profile lock, the registry policy and
 * the HMR hand-off.
 */
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ROUTE_PATH = '/plugin-updates';
const DEFAULT_POLICY_MINUTES = 1440;
const STATE_VERSION = 1;
const MAX_RESUME_ATTEMPTS = 2;
const MAX_BODY_BYTES = 64 * 1024;
const CHECK_TTL = 10 * 60 * 1000;
const CHECK_CONCURRENCY = 4;
const MAX_POLICY_MINUTES = 10080;
/** A restart request that never took the process down must not block the next attempt forever. */
const RESTART_HOLD_MS = 20 * 1000;
const KNOWN_ROUTES = new Set(['/check', '/prepare', '/cancel', '/ack', '/restart', '/policy']);

/** Injected by build.mjs from package.json, so the version has one source of truth. */
declare const __PU_VERSION__: string;
const VERSION = typeof __PU_VERSION__ === 'string' ? __PU_VERSION__ : '0.0.0-dev';

/** Declared dependency: routes need the HTTP server. */
export const inject = ['webServer'];

export function apply(ctx: any): void {
  const argv = parseArgv(process.argv);
  const profile = typeof argv.profile === 'string' ? argv.profile : 'web';
  const port = typeof argv.port === 'string' ? argv.port : '';

  let baseDir = resolveBaseDir(ctx);
  const nonce = randomId();

  // `profileContext` (and sometimes `hmr`) only appear a moment after this
  // plugin mounts, so every path resolves lazily instead of caching a null that
  // was sampled too early. A null here silently disables the restart queue.
  function profileDir() {
    if (baseDir === null) baseDir = resolveBaseDir(ctx);
    return baseDir;
  }

  function stateFile() {
    const dir = profileDir();
    return dir === null ? null : join(dir, '.plugin-updates', 'state.json');
  }

  let state = emptyState();
  let stateLoaded = false;
  function ensureState() {
    if (stateLoaded) return;
    const path = stateFile();
    if (path === null) return;
    state = loadState(path);
    stateLoaded = true;
  }
  ensureState();
  const runtimeVersion = detectRuntimeVersion();
  const checkCache = new Map();
  let resuming = false;
  let restarting = false;
  let restartAt = 0;
  let resumeTimer = null;

  const logInfo = (message) => {
    try { ctx.logger?.info?.(message); } catch { /* logging must never break the route */ }
  };
  const logWarn = (error) => {
    try { ctx.logger?.warn?.(error); } catch { /* ignore */ }
  };

  // ---------------------------------------------------------------- utilities

  /**
   * Write the queue state atomically. Returns false when there is nowhere to
   * write it, which callers must treat as "the queue cannot be kept" rather than
   * discovering it the next time the process comes up.
   */
  function persist() {
    const path = stateFile();
    if (path === null) return false;
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
      return true;
    } catch (error) {
      logWarn(error);
      return false;
    }
  }

  function manager() {
    try { return ctx.get('pluginManager'); } catch { return undefined; }
  }

  function policyInfo() {
    return readPolicyInfo(profileDir());
  }

  function snapshot(): any {
    const pending = state.queue.items.filter((item) => item.phase === 'pending');
    return {
      ok: true,
      host: {
        version: VERSION,
        policy: policyInfo().minutes,
        policyExplicit: policyInfo().explicit,
        policyFile: policyInfo().file,
        profile,
        port,
        baseDir: profileDir(),
        nonce,
        queueWritable: stateFile() !== null,
        runtimeVersion,
        restartStrategy: configuredRestartCommand() === null ? 'exit' : 'command',
      },
      queue: {
        trigger: state.queue.trigger,
        createdAt: state.queue.createdAt,
        attempts: state.queue.attempts,
        items: state.queue.items,
        pending: pending.length,
        needsRestart: pending.length > 0,
      },
      lastRun: state.lastRun,
    };
  }

  // --------------------------------------------------------------- operations

  /** Optional override: `<profile>/.plugin-updates/restart.json` `{ "command": "..." }` or DSH_RESTART_COMMAND. */
  function configuredRestartCommand() {
    const env = typeof process.env.DSH_RESTART_COMMAND === 'string' ? process.env.DSH_RESTART_COMMAND.trim() : '';
    if (env !== '') return env;
    try {
      const dir = profileDir();
      if (dir === null) return null;
      const file = join(dir, '.plugin-updates', 'restart.json');
      if (!existsSync(file)) return null;
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const command = typeof data?.command === 'string' ? data.command.trim() : '';
      return command === '' ? null : command;
    } catch {
      return null;
    }
  }

  /**
   * Restart the way the rest of the DSH ecosystem does it: flush the response, then
   * exit the process and let whatever supervises DSH start it again (Docker restart
   * policy, systemd Restart=, the desktop app). No platform tool is ever invoked.
   * A profile-local `restart.json` / DSH_RESTART_COMMAND can override the command.
   */
  async function restart() {
    if (restarting && Date.now() - restartAt < RESTART_HOLD_MS) {
      return { ok: false, error: { code: 'restart-busy', message: 'restart already requested' } };
    }
    const command = configuredRestartCommand();
    restarting = true;
    restartAt = Date.now();
    // If the process is still here in RESTART_HOLD_MS nothing took it down (an
    // environment that ignores the exit, or a failed override command); let the
    // user try again instead of answering 409 for the rest of the session.
    setTimeout(() => { restarting = false; }, RESTART_HOLD_MS);
    return { ok: true, strategy: command === null ? 'exit' : 'command', command };
  }

  function performRestart(plan) {
    if (plan.strategy === 'command' && typeof plan.command === 'string') {
      try {
        const child = exec(plan.command, { cwd: profileDir() ?? process.cwd(), detached: true, stdio: 'ignore' } as any);
        child.unref();
        logInfo(`[plugin-updates] restart command: ${plan.command}`);
      } catch (error) {
        logWarn(error);
      }
    }
    // Let the HTTP response flush before the process goes away; the supervisor
    // (Docker restart policy, systemd, the desktop app) brings DSH back.
    setTimeout(() => process.exit(0), 300);
  }

  // --------------------------------------------------------------- operations

  /**
   * Disable the bundles that must be swapped while unloaded, then record them.
   * The disable is what lets the next boot come up without loading them, so the
   * follow-up `removeBundle` can actually succeed.
   *
   * Order matters: the queue must be writable *before* anything is disabled,
   * because a queue that cannot be saved leaves plugins switched off with no
   * record to resume or cancel.
   */
  async function prepare(body) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return { ok: false, error: { code: 'invalid-request', message: 'items is empty' } };
    if (state.queue.items.some((item) => item.phase === 'pending')) {
      return { ok: false, error: { code: 'queue-busy', message: 'an upgrade queue is already pending' } };
    }
    if (stateFile() === null) {
      return { ok: false, error: { code: 'no-queue', message: 'the profile directory is unknown, so an upgrade queue cannot be written' } };
    }
    const pm = manager();
    if (pm === undefined) return { ok: false, error: { code: 'no-manager', message: 'pluginManager is unavailable' } };

    const queued = [];
    const failed = [];
    for (const raw of items) {
      const name = String(raw?.name ?? '');
      const to = String(raw?.to ?? '');
      const from = String(raw?.from ?? '');
      if (name === '' || to === '') { failed.push({ name, code: 'invalid-request', message: 'name/to required' }); continue; }
      const wasEnabled = raw?.wasEnabled !== false;
      try {
        if (wasEnabled) {
          const result = await pm.setBundleEnabled(name, false);
          if (result?.ok === false) {
            failed.push({ name, code: result.error?.code ?? 'operation-error', message: describe(result.error) });
            continue;
          }
        }
        queued.push({ name, from, to, wasEnabled, phase: 'pending' });
      } catch (error) {
        failed.push({ name, code: 'operation-error', message: String(error?.message ?? error) });
      }
    }
    if (queued.length === 0) return { ok: false, error: { code: 'nothing-queued', message: 'no bundle could be prepared' }, failed };

    state.queue = {
      trigger: typeof body?.trigger === 'string' ? body.trigger : 'restart',
      createdAt: new Date().toISOString(),
      attempts: 0,
      items: queued,
    };
    if (!persist()) {
      // Undo the disables: without a saved queue there is nothing to resume.
      state.queue = { trigger: null, createdAt: null, attempts: 0, items: [] };
      for (const item of queued) {
        try { await pm.setBundleEnabled(item.name, item.wasEnabled !== false); } catch { /* best effort */ }
      }
      return {
        ok: false,
        error: { code: 'no-queue', message: 'the upgrade queue could not be written; nothing was changed' },
        failed,
      };
    }
    logInfo(`[plugin-updates] queued ${queued.length} upgrade(s) for restart: ${queued.map((i) => i.name).join(', ')}`);
    return { ok: true, queued, failed };
  }

  /** Restore the enabled flag of every pending item and drop the queue. */
  async function cancel() {
    const restored = [];
    const pm = manager();
    for (const item of state.queue.items) {
      if (item.phase !== 'pending' || pm === undefined) continue;
      try {
        const result = await pm.setBundleEnabled(item.name, item.wasEnabled !== false);
        restored.push({ name: item.name, ok: result?.ok !== false });
      } catch (error) {
        restored.push({ name: item.name, ok: false, message: String(error?.message ?? error) });
      }
    }
    state.queue = { trigger: null, createdAt: null, attempts: 0, items: [] };
    persist();
    return { ok: true, restored };
  }

  /** Run the queued upgrades once the process is back up with them unloaded. */
  async function resume(reason) {
    if (resuming) return;
    ensureState();
    if (state.queue.items.length === 0) return;
    const pm = manager();
    if (pm === undefined) return;
    resuming = true;
    try {
      state.queue.attempts += 1;
      if (state.queue.attempts > MAX_RESUME_ATTEMPTS) {
        const trigger = state.queue.trigger;
        await cancel();
        state.lastRun = { at: new Date().toISOString(), trigger, results: [{ name: '*', status: 'aborted', message: 'too many resume attempts' }] };
        persist();
        logWarn(`[plugin-updates] aborted queue after ${MAX_RESUME_ATTEMPTS} attempts`);
        return;
      }
      persist();
      logInfo(`[plugin-updates] resuming ${state.queue.items.length} upgrade(s) (${reason})`);
      const results = [];
      for (const item of state.queue.items) {
        if (item.phase !== 'pending') continue;
        const outcome = await upgradeOne(pm, item);
        results.push(outcome);
        item.phase = outcome.status === 'upgraded' ? 'done' : 'failed';
        persist();
      }
      const trigger = state.queue.trigger;
      state.lastRun = { at: new Date().toISOString(), trigger, results };
      state.queue = { trigger: null, createdAt: null, attempts: 0, items: [] };
      persist();
      logInfo(`[plugin-updates] resume finished: ${results.map((r) => `${r.name}:${r.status}`).join(', ')}`);
    } catch (error) {
      logWarn(error);
    } finally {
      resuming = false;
    }
  }

  /**
   * Ask the manager what `name@to` would install before anything is removed.
   * Upgrading is remove-then-install (the manager refuses to add a dependency
   * that already exists while HMR is live), so a spec the registry cannot
   * resolve would otherwise cost the installed copy. Only refusals that are
   * certain — the package or version does not exist, the spec is malformed, the
   * registry is unreachable — block the upgrade; `already-installed` is the
   * normal answer for the copy we are about to replace, and any error of the
   * inspection itself fails open.
   */
  async function preflight(pm, name, to) {
    const blocking = new Set(['invalid-spec', 'not-found', 'not-a-package', 'not-a-bundle', 'network']);
    try {
      const inspection = await pm.inspect(`${name}@${to}`);
      if (inspection?.status === 'refused' && blocking.has(inspection.problem)) {
        return { code: inspection.problem, message: String(inspection.reason ?? '') };
      }
      return null;
    } catch {
      return null;
    }
  }

  async function upgradeOne(pm, item) {
    const target = `${item.name}@${item.to}`;
    const refused = await preflight(pm, item.name, item.to);
    if (refused !== null) {
      return {
        name: item.name,
        status: 'failed',
        stage: 'preflight',
        from: item.from,
        to: item.to,
        code: refused.code,
        message: refused.message,
      };
    }
    let removed;
    try {
      removed = await pm.removeBundle(item.name);
    } catch (error) {
      return { name: item.name, status: 'failed', stage: 'remove', message: String(error?.message ?? error) };
    }
    // A failed change still arrives as { ok: true, value: { application: 'failed', error } }.
    if (removed?.ok === false || removed?.value?.application === 'failed' || removed?.value?.error !== undefined) {
      await restoreEnabled(pm, item);
      return {
        name: item.name,
        status: 'failed',
        stage: 'remove',
        code: removed?.error?.code ?? removed?.value?.error?.code,
        message: describe(removed?.error ?? removed?.value?.error),
      };
    }
    let installed;
    try {
      installed = await pm.installBundle(target, { enabled: item.wasEnabled !== false, saveExact: true, requestId: randomId() });
    } catch (error) {
      installed = { ok: false, error: { code: 'operation-error', message: String(error?.message ?? error) } };
    }
    const failed = installed?.ok === false || installed?.value?.application === 'failed';
    if (!failed) {
      return {
        name: item.name,
        status: 'upgraded',
        from: item.from,
        to: item.to,
        application: installed?.value?.application ?? 'applied',
        restartReason: installed?.value?.restartReason,
      };
    }
    // Roll back to the version we started from, then make sure the bundle is
    // selected again even when the rollback itself fails.
    let rolledBack = false;
    if (item.from !== '') {
      try {
        const back = await pm.installBundle(`${item.name}@${item.from}`, { enabled: item.wasEnabled !== false, saveExact: true, requestId: randomId() });
        rolledBack = back?.ok !== false && back?.value?.application !== 'failed';
      } catch { rolledBack = false; }
    }
    await restoreEnabled(pm, item);
    return {
      name: item.name,
      status: rolledBack ? 'rolled-back' : 'failed',
      stage: 'install',
      from: item.from,
      to: item.to,
      code: installed?.error?.code ?? installed?.value?.error?.code,
      message: describe(installed?.error ?? installed?.value?.error),
    };
  }

  async function restoreEnabled(pm, item) {
    try {
      await pm.setBundleEnabled(item.name, item.wasEnabled !== false);
    } catch (error) {
      logWarn(error);
    }
  }

  // -------------------------------------------------------------- update check

  /**
   * Registry endpoints, newest preference first. The manager already resolved
   * the profile registry (mirror / fallback list), so reuse it instead of
   * guessing from npmrc ourselves.
   */
  async function registryBases() {
    const fallback = ['https://registry.npmjs.org/'];
    const pm = manager();
    if (pm === undefined) return fallback;
    try {
      const regs = await pm.registries();
      const list = [];
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return;
        const base = value.endsWith('/') ? value : `${value}/`;
        if (!list.includes(base)) list.push(base);
      };
      push(regs?.resolved);
      push(regs?.registry);
      for (const item of Array.isArray(regs?.fallbackRegistries) ? regs.fallbackRegistries : []) push(item);
      return list.length > 0 ? list : fallback;
    } catch {
      return fallback;
    }
  }

  /** `@scope/name` → `@scope%2fname`, plain names are percent-encoded as-is. */
  function registryPath(name) {
    if (name.startsWith('@')) return `@${encodeURIComponent(name.slice(1)).replace(/%2F/g, '%2f')}`;
    return encodeURIComponent(name);
  }

  /**
   * Newest published version of one package. Runs in the host process (not the
   * browser) so a corporate mirror, a proxy or a CORS-hostile registry still
   * works, and so a slow registry never blocks the UI thread.
   */
  async function fetchLatest(name, bases) {
    let lastError = '';
    for (const base of bases) {
      try {
        const response = await fetch(`${base}${registryPath(name)}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) { lastError = `${base} → HTTP ${response.status}`; continue; }
        const data = await response.json();
        const latest = data?.['dist-tags']?.latest;
        if (typeof latest !== 'string' || latest === '') { lastError = `${base} → no dist-tags.latest`; continue; }
        const published = data?.time?.[latest];
        const engines = data?.versions?.[latest]?.engines;
        return {
          ok: true,
          latest,
          publishedAt: typeof published === 'string' ? published : null,
          registry: base,
          engines: engines !== null && typeof engines === 'object' ? engines : null,
        };
      } catch (error) {
        lastError = `${base} → ${String(error?.message ?? error)}`;
      }
    }
    return { ok: false, error: lastError === '' ? 'no registry configured' : lastError };
  }

  async function check(body) {
    const names = Array.isArray(body?.names)
      ? body.names.filter((name) => typeof name === 'string' && name !== '')
      : [];
    const fresh = body?.fresh === true;
    if (names.length === 0) return { ok: true, checkedAt: new Date().toISOString(), results: {} };
    const bases = await registryBases();
    const results = {};
    let cursor = 0;
    const worker = async () => {
      while (cursor < names.length) {
        const name = names[cursor++];
        const cached = checkCache.get(name);
        let base;
        if (!fresh && cached !== undefined && Date.now() - cached.at < CHECK_TTL) {
          base = cached.value;
        } else {
          base = await fetchLatest(name, bases);
          checkCache.set(name, { at: Date.now(), value: base });
        }
        // The version actually on disk is authoritative: bundle.version may be a
        // range (`^0.8.11`) or a catalog version, never the installed one.
        results[name] = { ...base, installed: readInstalledVersion(name) };
      }
    };
    const workers = Math.min(CHECK_CONCURRENCY, names.length);
    await Promise.all(Array.from({ length: workers }, worker));
    logInfo(`[plugin-updates] checked ${names.length} package(s) against ${bases.join(', ')}`);
    return { ok: true, checkedAt: new Date().toISOString(), registries: bases, results };
  }

  /** The profile directory and an explicitly configured one — never the process cwd. */
  function installedRoots() {
    const roots = [];
    for (const candidate of [profileDir(), process.env.DSH_PROFILE_DIR]) {
      if (typeof candidate === 'string' && candidate !== '' && !roots.includes(candidate)) roots.push(candidate);
    }
    return roots;
  }

  function readInstalledVersion(name) {
    for (const root of installedRoots()) {
      try {
        const manifest = join(root, 'node_modules', name, 'package.json');
        if (!existsSync(manifest)) continue;
        const data = JSON.parse(readFileSync(manifest, 'utf8'));
        if (typeof data?.version === 'string' && data.version !== '') return data.version;
      } catch { /* try the next root */ }
    }
    return '';
  }

  // ------------------------------------------------------------------- routes

  async function handle(req, res) {
    if (req.headers['x-plugin-updates'] !== '1') {
      return json(res, 403, { ok: false, error: { code: 'forbidden', message: 'missing x-plugin-updates header' } });
    }
    ensureState();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.slice(ROUTE_PATH.length) || '/';

    if (req.method === 'GET' && (route === '/' || route === '/state')) {
      return json(res, 200, snapshot());
    }
    if (req.method === 'GET' && route === '/policy') {
      return json(res, 200, { ok: true, ...policyInfo() });
    }
    // Diagnostic only: what the tab's model receives (source drives 本地开发).
    if (req.method === 'GET' && route === '/bundles') {
      const pm = manager();
      if (pm === undefined) return json(res, 500, { ok: false, error: { code: 'no-manager' } });
      const list: any[] = await pm.listBundles();
      return json(res, 200, {
        ok: true,
        value: (Array.isArray(list) ? list : []).map((item: any) => ({
          name: item.name,
          source: item.source ?? null,
          version: item.version ?? null,
          installed: item.installed !== false,
          official: item.official === true,
          removable: item.removable !== false,
          enabled: item.enabled !== false,
        })),
      });
    }
    if (!KNOWN_ROUTES.has(route)) {
      return json(res, 404, { ok: false, error: { code: 'not-found', message: route } });
    }
    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `${req.method} ${route}` } });
    }
    if (req.headers['x-plugin-updates-nonce'] !== nonce) {
      return json(res, 403, { ok: false, error: { code: 'stale-nonce', message: 'reload the page and retry' } });
    }
    const body: any = await readJson(req);

    switch (route) {
      case '/check':
        return json(res, 200, await check(body));
      case '/prepare':
        return json(res, 200, await prepare(body));
      case '/cancel':
        return json(res, 200, await cancel());
      case '/ack':
        state.lastRun = null;
        persist();
        return json(res, 200, { ok: true });
      case '/restart': {
        const result = await restart();
        if (!result.ok) return json(res, 409, result);
        json(res, 202, { ok: true, strategy: result.strategy });
        setTimeout(() => performRestart(result), 250);
        return undefined;
      }
      case '/policy': {
        const minutes = body?.minutes;
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_POLICY_MINUTES) {
          return json(res, 400, {
            ok: false,
            error: { code: 'invalid-request', message: `minutes must be an integer between 0 and ${MAX_POLICY_MINUTES}` },
          });
        }
        const applied = writePolicy(profileDir(), minutes);
        if (applied === null) {
          return json(res, 409, {
            ok: false,
            error: { code: 'no-policy-file', message: 'the profile has no pnpm-workspace.yaml, so there is no policy to change' },
          });
        }
        return json(res, 200, { ok: true, minutes: applied, explicit: true, defaultMinutes: DEFAULT_POLICY_MINUTES, file: policyInfo().file });
      }
      default:
        return json(res, 404, { ok: false, error: { code: 'not-found', message: route } });
    }
  }

  // --------------------------------------------------------------- lifecycle

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: (req, res) => {
        handle(req, res).catch((error) => {
          logWarn(error);
          if (!res.headersSent) json(res, 500, { ok: false, error: { code: 'operation-error', message: String(error?.message ?? error) } });
          else res.end();
        });
      },
    }),
    'plugin-updates: http routes',
  );

  {
    // Boot signals. `appReady.onReady` fires once startup is committed — by then
    // the queued bundles are known to be inactive and can be swapped safely.
    // `app-boot/config-reload` covers HMR reconciles; the timer is a last resort.
    const kick = (reason) => {
      if (resumeTimer !== null) return;
      resumeTimer = setTimeout(() => { resumeTimer = null; void resume(reason); }, 400);
      try { resumeTimer.unref?.(); } catch { /* ignore */ }
    };
    try {
      const ready = ctx.get('appReady');
      if (ready !== undefined && typeof ready.onReady === 'function') {
        ctx.effect(() => ready.onReady(() => kick('boot')), 'plugin-updates: boot resume');
      }
    } catch { /* ignore */ }
    ctx.on('app-boot/config-reload', () => kick('config-reload'));
    const fallback = setTimeout(() => { kick('boot-fallback'); }, 15000);
    try { fallback.unref?.(); } catch { /* ignore */ }
  }

  logInfo(`[plugin-updates] host ready on ${ROUTE_PATH} (profile=${profile}, baseDir=${baseDir ?? 'unknown'})`);
}

// ------------------------------------------------------------------- helpers

function resolveBaseDir(ctx) {
  const candidates = [];
  const push = (value) => { if (typeof value === 'string' && value !== '') candidates.push(value); };
  try { push(ctx.get('profileContext')?.dir); } catch { /* ignore */ }
  try { push(ctx.get('hmr')?.baseDir); } catch { /* ignore */ }
  try { push(ctx.baseDir); } catch { /* ignore */ }
  push(process.env.DSH_PROFILE_DIR);
  const profile = parseArgv(process.argv).profile;
  if (typeof profile === 'string') {
    if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
      push(join(process.env.DSH_HOME, 'profiles', profile));
    }
    try { push(join(homedir(), '.dsh', 'profiles', profile)); } catch { /* ignore */ }
    push(join('/data/dsh', 'profiles', profile));
  }
  push(process.cwd());
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function emptyState() {
  return { version: STATE_VERSION, queue: { trigger: null, createdAt: null, attempts: 0, items: [] }, lastRun: null };
}

function loadState(path) {
  const empty = emptyState();
  if (path === null || !existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== STATE_VERSION) return empty;
    return {
      version: STATE_VERSION,
      queue: {
        trigger: parsed.queue?.trigger ?? null,
        createdAt: parsed.queue?.createdAt ?? null,
        attempts: Number.isInteger(parsed.queue?.attempts) ? parsed.queue.attempts : 0,
        items: Array.isArray(parsed.queue?.items) ? parsed.queue.items : [],
      },
      lastRun: parsed.lastRun ?? null,
    };
  } catch {
    return empty;
  }
}

function parseArgv(argv: string[]): Record<string, any> {
  const out = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) { out[key] = inline; continue; }
    const next = argv[index + 1];
    if (typeof next === 'string' && !next.startsWith('--')) { out[key] = next; index += 1; } else { out[key] = true; }
  }
  return out;
}

/**
 * Version of the DSH runtime that is executing this profile. Walks up from the
 * launcher script (…/@deepseek-ai/dsh/lib/bin.js) to the package manifest, so it
 * keeps working after an image bump without hardcoding a path.
 */
function detectRuntimeVersion() {
  try {
    const entry = process.argv[1];
    if (typeof entry !== 'string' || entry === '') return '';
    let dir = dirname(realpathSync(entry));
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        try {
          const data = JSON.parse(readFileSync(manifest, 'utf8'));
          if (typeof data?.version === 'string' && data.version !== '') return data.version;
        } catch { /* keep walking */ }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }
  return '';
}

function describe(error) {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error;
  const raw = typeof error.diagnostic === 'string' && error.diagnostic !== '' ? error.diagnostic : (error.message ?? '');
  if (raw !== '') {
    const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const coded = lines.find((line) => /\[ERR_[A-Z0-9_]+\]/.test(line)) ?? lines.find((line) => /^ERR_[A-Z0-9_]+/.test(line));
    const picked = coded ?? lines[0] ?? raw;
    return picked.length > 300 ? `${picked.slice(0, 300)}…` : picked;
  }
  return error.code ?? 'unknown error';
}

function policyFile(dir) {
  return join(dir, 'pnpm-workspace.yaml');
}

/** Current pnpm supply-chain quarantine window, in minutes (null = pnpm default). */
function readPolicyInfo(dir) {
  const file = typeof dir === 'string' && dir !== '' ? policyFile(dir) : null;
  const fallback = { minutes: DEFAULT_POLICY_MINUTES, explicit: false, defaultMinutes: DEFAULT_POLICY_MINUTES, file };
  if (file === null) return fallback;
  try {
    const match = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(readFileSync(file, 'utf8'));
    if (match === null) return fallback;
    return { minutes: Number(match[1]), explicit: true, defaultMinutes: DEFAULT_POLICY_MINUTES, file };
  } catch {
    return fallback;
  }
}
/**
 * pnpm 11 quarantines packages younger than 24h and re-verifies the whole lockfile on every
 * install, so one fresh version in the lockfile blocks every later operation. Writing an
 * explicit minimumReleaseAge is the documented way to relax that.
 *
 * Only an existing `pnpm-workspace.yaml` is edited (creating one in a profile that does not
 * use pnpm would add a file the user never asked for), and the previous content is kept
 * next to it so the change is reversible by hand. Returns null when nothing was written.
 */
function writePolicy(dir, minutes) {
  const value = Math.max(0, Math.min(MAX_POLICY_MINUTES, Math.floor(minutes)));
  const file = policyFile(dir);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const line = `minimumReleaseAge: ${value}`;
  const next = /^minimumReleaseAge:.*$/m.test(text) ? text.replace(/^minimumReleaseAge:.*$/m, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
  writeFileSync(`${file}.bak`, text, 'utf8');
  writeFileSync(file, next, 'utf8');
  return value;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); resolve({}); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}


function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

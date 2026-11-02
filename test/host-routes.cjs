#!/usr/bin/env node
/**
 * Host-half smoke test: mounts dist/index.js on a stub cordis ctx and drives the
 * real HTTP handler. No network, no profile writes outside a temp dir, no restart.
 *
 *   node test/host-routes.cjs
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const HOST_BUNDLE = path.join(ROOT, 'dist/index.js');

function tempProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pu-profile-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'web', version: '0.0.0' }));
  return dir;
}

function makeCtx(profileDir, holder) {
  const routes = [];
  const events = new Map();
  const bootHooks = [];
  return {
    routes,
    events,
    bootHooks,
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'profileContext') return { dir: profileDir };
      if (name === 'pluginManager') return holder.pm;
      if (name === 'appReady') return { onReady: (cb) => { bootHooks.push(cb); return () => {}; } };
      return undefined;
    },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
    },
    effect(fn) { fn(); return () => {}; },
    on(event, cb) { events.set(event, cb); return () => {}; },
  };
}

function makeReq(method, url, headers, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    url,
    headers: Object.assign({}, headers),
    on(event, cb) { (listeners[event] || (listeners[event] = [])).push(cb); return req; },
    destroy() {},
  };
  setImmediate(() => {
    if (body !== undefined) {
      const chunk = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      for (const cb of listeners.data) cb(chunk);
    }
    for (const cb of listeners.end) cb();
  });
  return req;
}

function call(handler, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const url = `/plugin-updates${route}`;
    const res = {
      status: 0,
      headers: null,
      body: '',
      writeHead(status, out) { this.status = status; this.headers = out; },
      end(chunk) { this.body = chunk === undefined ? '' : String(chunk); resolve(this); },
      reload() { throw new Error('the host half must never reload the page'); },
    };
    try {
      handler(makeReq(method, url, headers, body), res);
    } catch (error) {
      reject(error);
    }
  });
}

async function main() {
  const profileDir = tempProfile();
  const holder = { pm: undefined };
  const ctx = makeCtx(profileDir, holder);
  const mod = await import(`file://${HOST_BUNDLE}?t=${Date.now()}`);
  assert.deepStrictEqual(mod.inject, ['webServer'], 'inject must stay minimal');

  let disposed = 0;
  ctx.webServer.register = (route) => { ctx.routes.push(route); return () => { disposed += 1; }; };
  mod.apply(ctx);

  assert.strictEqual(ctx.routes.length, 1, 'exactly one HTTP route is registered');
  const route = ctx.routes[0];
  assert.strictEqual(route.kind, 'prefix');
  assert.strictEqual(route.path, '/plugin-updates');
  const handler = route.handler;
  assert.strictEqual(typeof handler, 'function');

  // 1. the private header is mandatory
  let res = await call(handler, 'GET', '/state', {});
  assert.strictEqual(res.status, 403, 'missing x-plugin-updates must be 403');
  assert.strictEqual(JSON.parse(res.body).error.code, 'forbidden');

  // 2. /state works and reports the version injected at build time
  res = await call(handler, 'GET', '/state', { 'x-plugin-updates': '1' });
  assert.strictEqual(res.status, 200);
  const state = JSON.parse(res.body);
  assert.strictEqual(state.ok, true);
  assert.strictEqual(state.host.version, PKG.version, 'host version must match package.json');
  assert.strictEqual(typeof state.host.nonce, 'string');
  assert.ok(state.host.nonce.length > 0, 'a nonce is generated for this process');
  assert.strictEqual(state.host.baseDir, profileDir, 'baseDir resolves to the profile dir');
  assert.strictEqual(state.host.queueWritable, true);

  // 3. the debug probe is gone: ?probe=1 returns the same snapshot, nothing else
  res = await call(handler, 'GET', '/state?probe=1', { 'x-plugin-updates': '1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).host.nonce, state.host.nonce);

  // 4. /bundles needs the plugin manager
  res = await call(handler, 'GET', '/bundles', { 'x-plugin-updates': '1' });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(JSON.parse(res.body).error.code, 'no-manager');

  // 5. routes the client cannot reach are gone
  const nonce = state.host.nonce;
  const post = (route2, body) => call(handler, 'POST', route2, { 'x-plugin-updates': '1', 'x-plugin-updates-nonce': nonce }, body);
  for (const dead of ['/repair', '/resume']) {
    res = await post(dead, {});
    assert.strictEqual(res.status, 404, `${dead} must not exist`);
    assert.strictEqual(JSON.parse(res.body).error.code, 'not-found');
  }

  // 6. POST needs the nonce
  res = await call(handler, 'POST', '/ack', { 'x-plugin-updates': '1' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(JSON.parse(res.body).error.code, 'stale-nonce');

  // 7. /ack clears the last run
  res = await post('/ack', {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).ok, true);

  // 8. /policy validates input instead of writing garbage
  for (const bad of [{ minutes: -1 }, { minutes: 10081 }, { minutes: 1.5 }, { minutes: '60' }, {}]) {
    res = await post('/policy', bad);
    assert.strictEqual(res.status, 400, `minutes=${JSON.stringify(bad.minutes)} must be rejected`);
    assert.strictEqual(JSON.parse(res.body).error.code, 'invalid-request');
  }

  // 9. no pnpm-workspace.yaml means "do not create one"
  const policyFile = path.join(profileDir, 'pnpm-workspace.yaml');
  assert.strictEqual(fs.existsSync(policyFile), false);
  res = await post('/policy', { minutes: 60 });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(JSON.parse(res.body).error.code, 'no-policy-file');
  assert.strictEqual(fs.existsSync(policyFile), false, 'the host must not create the policy file');

  // 10. an existing policy is rewritten atomically, with a .bak of the old text
  fs.writeFileSync(policyFile, 'packages:\n  - .\nminimumReleaseAge: 1440\n');
  res = await post('/policy', { minutes: 0 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).minutes, 0);
  assert.match(fs.readFileSync(policyFile, 'utf8'), /^minimumReleaseAge: 0$/m);
  assert.match(fs.readFileSync(`${policyFile}.bak`, 'utf8'), /^minimumReleaseAge: 1440$/m);
  assert.match(fs.readFileSync(policyFile, 'utf8'), /packages:/, 'other keys survive the rewrite');

  // 11. GET /policy reports what is on disk
  res = await call(handler, 'GET', '/policy', { 'x-plugin-updates': '1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).minutes, 0);

  // 12. unknown paths and wrong methods are refused
  res = await call(handler, 'GET', '/nothing', { 'x-plugin-updates': '1' });
  assert.strictEqual(res.status, 404);
  res = await call(handler, 'POST', '/nothing', { 'x-plugin-updates': '1', 'x-plugin-updates-nonce': nonce }, {});
  assert.strictEqual(res.status, 404);
  res = await call(handler, 'GET', '/check', { 'x-plugin-updates': '1' });
  assert.strictEqual(res.status, 405);

  // ---------------------------------------------------------------- phase 2:
  // queue -> boot resume -> remove/install, plus a preflight refusal that must
  // leave the installed version alone.
  const calls = [];
  const fakePm = {
    async listBundles() { return []; },
    async registries() { return { resolved: 'https://registry.npmjs.org/' }; },
    async setBundleEnabled(name, enabled) { calls.push(['enable', name, enabled]); return { ok: true, value: {} }; },
    async removeBundle(name) { calls.push(['remove', name]); return { ok: true, value: { application: 'applied' } }; },
    async installBundle(spec, options) { calls.push(['install', spec, options?.enabled]); return { ok: true, value: { application: 'applied' } }; },
    async inspect(spec) {
      calls.push(['inspect', spec]);
      return spec.startsWith('good@')
        ? { status: 'accepted', kind: 'package', name: spec.split('@')[0], version: spec.split('@')[1], bundle: true, registry: 'https://registry.npmjs.org/' }
        : { status: 'refused', problem: 'not-found', reason: '404 Not Found', registries: ['https://registry.npmjs.org/'] };
    },
  };

  holder.pm = fakePm;

  // A queued upgrade that the boot hook must finish: disable now, upgrade after restart.
  res = await post('/prepare', { trigger: 'restart', items: [{ name: 'good', from: '1.0.0', to: '1.1.0', wasEnabled: true }] });
  assert.strictEqual(res.status, 200, res.body);
  const prepared = JSON.parse(res.body);
  assert.strictEqual(prepared.ok, true);
  assert.strictEqual(prepared.queued.length, 1);
  assert.deepStrictEqual(calls.at(-1), ['enable', 'good', false], 'the bundle is disabled before the restart');

  res = await call(handler, 'GET', '/state', { 'x-plugin-updates': '1' });
  assert.strictEqual(JSON.parse(res.body).queue.pending, 1, 'the queue is persisted');

  const fire = ctx.events.get('app-boot/config-reload');
  assert.strictEqual(typeof fire, 'function', 'the boot resume hook is subscribed');
  fire();
  await new Promise((resolve) => setTimeout(resolve, 900));

  res = await call(handler, 'GET', '/state', { 'x-plugin-updates': '1' });
  const after = JSON.parse(res.body);
  assert.strictEqual(after.queue.pending, 0, 'the queue drains after the resume');
  assert.strictEqual(after.lastRun.results.length, 1);
  assert.strictEqual(after.lastRun.results[0].status, 'upgraded');
  assert.deepStrictEqual(calls.filter((item) => item[0] === 'remove'), [['remove', 'good']]);
  const install = calls.filter((item) => item[0] === 'install');
  assert.strictEqual(install.length, 1);
  assert.strictEqual(install[0][1], 'good@1.1.0');
  assert.strictEqual(install[0][2], true, 'the original enabled state is restored');

  // A queued upgrade whose target does not exist must not touch the installed copy.
  calls.length = 0;
  res = await post('/prepare', { trigger: 'restart', items: [{ name: 'bad', from: '2.0.0', to: '9.9.9', wasEnabled: true }] });
  assert.strictEqual(res.status, 200);
  fire();
  await new Promise((resolve) => setTimeout(resolve, 900));
  res = await call(handler, 'GET', '/state', { 'x-plugin-updates': '1' });
  const refused = JSON.parse(res.body).lastRun;
  assert.strictEqual(refused.results[0].status, 'failed');
  assert.strictEqual(refused.results[0].stage, 'preflight');
  assert.strictEqual(calls.some((item) => item[0] === 'remove'), false, 'preflight runs before any removal');
  assert.deepStrictEqual(calls.filter((item) => item[0] === 'inspect'), [['inspect', 'bad@9.9.9']]);

  fs.rmSync(profileDir, { recursive: true, force: true });
  console.log('OK — one route, private header, injected version, no probe, no dead routes,');
  console.log('     policy guarded, queue survives a restart, preflight blocks before removal');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

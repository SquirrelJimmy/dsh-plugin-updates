/**
 * Client half of dsh-plugin-updates.
 *
 * Renders the 「更新」 tab inside the built-in Plugins page. Everything that
 * changes the profile goes through the built-in `pluginManager` remote service
 * (never pnpm directly); the small host half only adds three things the remote
 * service cannot do: registry lookups (server side, so mirrors/CORS do not
 * matter), a persisted restart queue, and the process restart itself.
 */

/** Injected by build.mjs from package.json. */
declare const __PU_VERSION__: string;

(window as any).__ModuleLoader__.load({
  id: 'dsh-plugin-updates',
  factory(require: any) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'pluginUpdates';
    /** Injected by build.mjs from package.json. Shown in the toolbar so a screenshot says which client build is running. */
    const CLIENT_VERSION = typeof __PU_VERSION__ === 'string' ? __PU_VERSION__ : '0.0.0-dev';
    const inject = ['slots', 'locale', 'remote', 'remote.pluginManager'];
    const PAGE = '/plugin-updates';
    const CACHE_KEY = 'dsh-plugin-updates:check:v1';
    const RUNTIME_PACKAGE = '@deepseek-ai/dsh';
    const QUARANTINE_MS = 24 * 60 * 60 * 1000;

    // ------------------------------------------------------------------ i18n

    const zh = {
      title: '更新',
      check: '检测更新',
      checking: '检测中…',
      upgradeAll: '全部升级',
      refresh: '刷新',
      lastChecked: '上次检测 {time}',
      never: '尚未检测，点「检测更新」查询最新版本',
      summaryLine: '{outdated} 个可升级 · {total} 个已安装',
      colPlugin: '插件',
      colCurrent: '当前版本',
      colLatest: '可升级到',
      colDesc: '简介',
      colStatus: '状态',
      colAction: '操作',
      statusUnchecked: '未检测',
      statusLatest: '已最新',
      statusOutdated: '可升级',
      statusSkipped: '跳过（隔离期）',
      buildTitle: '需要执行构建脚本',
      buildBody: '以下依赖带有构建脚本，pnpm 默认不执行：\n\n{list}\n\n批准后重新安装并执行构建；跳过则本次不升级。',
      buildApprove: '批准并安装',
      buildSkip: '跳过',
      buildSkipped: '已跳过（未批准构建脚本）',
      skipNote: '该版本发布于 {window} 内，pnpm 的 minimumReleaseAge 会拒绝安装；等隔离期结束，或自己调整「隔离期」设置。',
      statusUnknown: '无法检测',
      statusImage: '内置',
      statusLocal: '本地开发',
      statusRestart: '待重启',
      statusDisabled: '已停用',
      upgrade: '升级',
      upgrading: '升级中…',
      restart: '重启',
      restarting: '重启中…',
      restartTitle: '需要重启 DSH',
      restartBody: '有 {n} 个插件已下载新版本，需要重启 DSH 才能生效。点「立即重启」会让当前 DSH 进程退出，再由启动它的外层（Docker 重启策略 / systemd / 桌面端）拉起，本页面断开约 10–30 秒后自动刷新。如果 DSH 是在终端里手工启动的、没有守护进程，进程退出后不会自己回来，需要在终端重新执行启动命令。',
      restartLater: '稍后再说',
      restartNow: '立即重启',
      batchTitle: '确认全部升级',
      batchBody: '将依次升级 {n} 个插件：\n{list}\n\n升级过程中请不要关闭页面。',
      cancel: '取消',
      start: '开始升级',
      summaryTitle: '升级结果',
      summaryOk: '成功 {n}',
      summaryFail: '失败 {n}',
      summaryRestart: '待重启 {n}',
      gotIt: '知道了',
      queueBanner: '{n} 个插件的升级正在等待重启完成',
      queueCancel: '取消并恢复',
      records: '升级记录',
      noRecords: '暂无记录',
      progress: '正在升级 {name}（{done}/{total}）',
      imageNote: 'DSH 内置插件，随 DSH 版本一起升级，应用内无法单独更新',
      localNote: '本地链接安装，不参与升级检测',
      quarantine: '发布不足 24 小时',
      quarantineShort: '{window} 内发布',
      runtimeOutdated: 'DSH 有新版本 {latest}（当前 {current}），需要重建镜像才能升级',
      noTarget: '缺少目标版本',
      errNoReply: '宿主没有响应',
      errTimeout: '等待超时：后台可能仍在安装，稍后点「刷新」看结果。',
      errCancelled: '操作已取消',
      errUnknown: '未知错误',
      errAlreadyInstalled: '该包已在依赖里（上一次操作残留），刷新后重试即可。',
      errNotRemovable: '该插件是 DSH 内置插件，不能在应用内卸载或升级。',
      errBundleInUse: '该插件正在被使用，需要重启后才能升级。',
      errQuarantine: '该版本发布不足 24 小时，被 pnpm 的供应链策略（minimumReleaseAge）拦截。等它满 24 小时，或放宽 profile 里的 pnpm-workspace.yaml 策略后再试。',
      policyHint: 'pnpm 默认隔离 24 小时内发布的版本；一旦这种版本进了 lockfile，后续所有安装都会被拦。',
      fixPolicy: '放宽隔离期',
      policyEntry: '隔离期',
      policyTitle: 'pnpm 隔离期（minimumReleaseAge）',
      diagnose: '诊断',
      diagnoseTitle: '复制每行的 source/version/状态，便于定位显示问题',
      diagnoseCopied: '已复制 {n} 行诊断信息到剪贴板',
      policyCurrent: '当前：',
      policyDefault: '默认值',
      policyOff: '关闭',
      summarySkipped: '跳过 {n} 个',
      policyFixed: '已把 minimumReleaseAge 调整为 {minutes} 分钟，请重试升级。',
      verifyFail: '安装命令完成，但版本没有变化',
      rolledBack: '已回滚到 {version}',
      failRemoved: '旧版本已卸载，新版本未装上',
      recoveryHint: '恢复命令：{cmd}',
      preflightRefused: '这个版本装不上，已取消升级（插件保持原样）',
      restartQueued: '已排队，重启后完成',
      checkFailed: '检测失败',
      loadFailed: '读取插件列表失败',
      headerRestart: '立即重启',
      restoreHint: '取消会把本次已停用的插件恢复为启用状态',
      partial: '有 {n} 个包检测失败（注册表不可达）',
      restartTimeout: '重启超时，请手动重启 DSH',
      clearRecords: '清空记录',
    };

    const en = {
      title: 'Updates',
      check: 'Check for updates',
      checking: 'Checking…',
      upgradeAll: 'Upgrade all',
      refresh: 'Refresh',
      lastChecked: 'Checked {time}',
      never: 'Not checked yet — run a check to compare with the registry',
      summaryLine: '{outdated} update(s) · {total} installed',
      colPlugin: 'Plugin',
      colCurrent: 'Installed',
      colLatest: 'Latest',
      colDesc: 'Description',
      colStatus: 'Status',
      colAction: 'Action',
      statusUnchecked: 'Not checked',
      statusLatest: 'Up to date',
      statusOutdated: 'Update available',
      statusSkipped: 'Skipped (quarantine)',
      buildTitle: 'Build scripts required',
      buildBody: 'These dependencies declare build scripts that pnpm does not run by default:\n\n{list}\n\nApprove to reinstall and run them, or skip this upgrade.',
      buildApprove: 'Approve and install',
      buildSkip: 'Skip',
      buildSkipped: 'Skipped (build scripts not approved)',
      skipNote: 'Published within {window}; pnpm minimumReleaseAge would reject it. Wait, or adjust the 隔离期 setting yourself.',
      statusUnknown: 'Check failed',
      statusImage: 'Bundled',
      statusLocal: 'Local dev',
      statusRestart: 'Restart needed',
      statusDisabled: 'Disabled',
      upgrade: 'Upgrade',
      upgrading: 'Upgrading…',
      restart: 'Restart',
      restarting: 'Restarting…',
      restartTitle: 'Restart DSH',
      restartBody: '{n} plugin(s) downloaded a new version. DSH must restart before they take effect. Restart now exits this DSH process and leaves it to whatever supervises it (a Docker restart policy, systemd, the desktop app) to start it again; this page disconnects for 10–30 seconds and reloads itself. If DSH was started by hand in a terminal with nothing supervising it, it will not come back on its own — re-run the start command there.',
      restartLater: 'Later',
      restartNow: 'Restart now',
      batchTitle: 'Upgrade all',
      batchBody: 'Will upgrade {n} plugin(s) one after another:\n{list}\n\nKeep this page open while it runs.',
      cancel: 'Cancel',
      start: 'Start',
      summaryTitle: 'Upgrade result',
      summaryOk: 'Succeeded {n}',
      summaryFail: 'Failed {n}',
      summaryRestart: 'Restart pending {n}',
      gotIt: 'Got it',
      queueBanner: '{n} upgrade(s) waiting for a restart',
      queueCancel: 'Cancel and restore',
      records: 'History',
      noRecords: 'No records yet',
      progress: 'Upgrading {name} ({done}/{total})',
      imageNote: 'Built into DSH; upgraded together with DSH, not individually in-app',
      localNote: 'Linked local package, excluded from update checks',
      quarantine: 'Published less than 24h ago',
      quarantineShort: 'new <{window}',
      runtimeOutdated: 'DSH {latest} is available (running {current}) — rebuild the image to upgrade',
      noTarget: 'No target version',
      errNoReply: 'The host did not respond',
      errTimeout: 'Timed out — the install may still be running in the background; press Refresh in a moment.',
      errCancelled: 'Cancelled',
      errUnknown: 'Unknown error',
      errAlreadyInstalled: 'The package is already in the profile dependencies (left over from an earlier attempt). Refresh and retry.',
      errNotRemovable: 'This plugin is built into DSH; it cannot be removed or upgraded in-app.',
      errBundleInUse: 'This plugin is in use; it can only be upgraded after a restart.',
      errQuarantine: 'That version was published less than 24 hours ago and is blocked by pnpm minimumReleaseAge. Wait until it is older, or relax the policy in the profile pnpm-workspace.yaml.',
      policyHint: 'pnpm quarantines versions younger than 24h; once one lands in the lockfile every later install is rejected.',
      fixPolicy: 'Relax quarantine',
      policyEntry: 'Quarantine',
      policyTitle: 'pnpm minimumReleaseAge',
      diagnose: 'Diagnose',
      diagnoseTitle: 'Copy source/version/status for every row',
      diagnoseCopied: 'Copied {n} rows of diagnostics to the clipboard',
      policyCurrent: 'Current:',
      policyDefault: 'default',
      policyOff: 'Off',
      summarySkipped: '{n} skipped',
      policyFixed: 'minimumReleaseAge is now {minutes} minutes — retry the upgrade.',
      verifyFail: 'Install finished but the version did not change',
      rolledBack: 'Rolled back to {version}',
      failRemoved: 'Old version removed, new version not installed',
      recoveryHint: 'Recover with: {cmd}',
      preflightRefused: 'That version cannot be installed, so the upgrade was cancelled (the plugin is untouched)',
      restartQueued: 'Queued, finishes after restart',
      checkFailed: 'Check failed',
      loadFailed: 'Could not read the plugin list',
      headerRestart: 'Restart now',
      restoreHint: 'Cancelling re-enables every plugin that was disabled for this upgrade.',
      partial: '{n} package(s) could not be checked (registry unreachable)',
      restartTimeout: 'Restart timed out — restart DSH manually',
      clearRecords: 'Clear',
    };

    const dict = (locale) => (String(locale).toLowerCase().startsWith('en') ? en : zh);

    const fmt = (template, vars) =>
      String(template).replace(/\{(\w+)\}/g, (whole, key) => (vars[key] === undefined ? whole : String(vars[key])));

    // --------------------------------------------------------------- helpers

    function parseVersion(value) {
      const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim());
      if (match === null) return null;
      return {
        parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
        pre: match[4] ?? '',
      };
    }

    /** >0 when a is newer than b, <0 when older, 0 when equal, null when unknown. */
    function compareVersions(a, b) {
      const left = parseVersion(a);
      const right = parseVersion(b);
      if (left === null || right === null) return null;
      for (let index = 0; index < 3; index += 1) {
        if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
      }
      if (left.pre === right.pre) return 0;
      if (left.pre === '') return 1;
      if (right.pre === '') return -1;
      return left.pre < right.pre ? -1 : 1;
    }

    function isExactVersion(value) {
      return /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(String(value ?? '').trim());
    }

    function errorText(error) {
      if (error === undefined || error === null) return '';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message !== '') return error.message;
      if (typeof error.diagnostic === 'string' && error.diagnostic !== '') return error.diagnostic;
      if (typeof error.code === 'string') return error.code;
      try { return JSON.stringify(error); } catch { return String(error); }
    }

    function uuid() {
      try { return crypto.randomUUID(); } catch { /* fall through */ }
      return `pu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function fmtClock(iso) {
      const date = iso === null || iso === undefined ? new Date() : new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function fmtDateTime(iso) {
      const date = iso === null || iso === undefined ? new Date() : new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    // Local link packages read better without their `@local/` scope.
    function displayName(name) {
      const text = String(name ?? '');
      return text.startsWith('@local/') ? text.slice('@local/'.length) : text;
    }

    function pickText(value) {
      if (typeof value === 'string') return value;
      if (value !== null && typeof value === 'object') {
        for (const key of ['zh', 'zh-CN', 'zh-cn', 'en']) {
          if (typeof value[key] === 'string' && value[key] !== '') return value[key];
        }
        for (const key of Object.keys(value)) {
          if (typeof value[key] === 'string' && value[key] !== '') return value[key];
        }
      }
      return '';
    }

    function readCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (raw === null) return { at: null, results: {} };
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return { at: null, results: {} };
        return {
          at: typeof parsed.at === 'string' ? parsed.at : null,
          results: parsed.results !== null && typeof parsed.results === 'object' ? parsed.results : {},
        };
      } catch {
        return { at: null, results: {} };
      }
    }

    function writeCache(at, results) {
      try { window.localStorage.setItem(CACHE_KEY, JSON.stringify({ at, results })); } catch { /* ignore quota */ }
    }

    // ------------------------------------------------------------ host routes

    function makeHost(): any {
      let nonce = '';

      async function call(path: string, options: any = {}): Promise<any> {
        const opts = options ?? {};
        const method = opts.method ?? 'GET';
        const headers = { 'x-plugin-updates': '1' };
        if (method !== 'GET') headers['content-type'] = 'application/json';
        if (opts.nonce === true && nonce !== '') headers['x-plugin-updates-nonce'] = nonce;
        let response;
        try {
          response = await fetch(`${PAGE}${path}`, {
            method,
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
            credentials: 'same-origin',
            signal: AbortSignal.timeout(opts.timeout ?? 60000),
          });
        } catch (error) {
          return { ok: false, error: { code: 'network', message: errorText(error) } };
        }
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        if (data === null) return { ok: false, error: { code: `http-${response.status}`, message: `HTTP ${response.status}` } };
        return data;
      }

      async function state() {
        const data = await call('/state');
        if (data?.ok && typeof data.host?.nonce === 'string') nonce = data.host.nonce;
        return data;
      }

      // The write routes require the nonce the host hands out with /state. A click
      // that lands before the first /state reply would otherwise be refused as
      // stale-nonce, so fetch it once and retry that one time.
      async function post(path: string, body: any, timeout?: number) {
        if (nonce === '') await state().catch(() => undefined);
        const first = await call(path, { method: 'POST', body: body ?? {}, nonce: true, timeout });
        if (first?.ok === false && first?.error?.code === 'stale-nonce') {
          await state().catch(() => undefined);
          return call(path, { method: 'POST', body: body ?? {}, nonce: true, timeout });
        }
        return first;
      }

      return { state, post, nonce: () => nonce };
    }

    // ------------------------------------------------------------------ styles

    const CSS = `
.pu-wrap { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 24px; font-size: 13px; color: var(--dsw-alias-text-primary, #1f2329); }
.pu-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pu-bar .pu-spacer { flex: 1; }
.pu-hint { font-size: 12px; color: var(--dsw-alias-text-tertiary, #8f959e); }
.pu-btn { height: 30px; padding: 0 12px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); background: transparent; color: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.pu-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-hover, rgba(0,0,0,.04)); }
.pu-btn:disabled { opacity: .45; cursor: not-allowed; }
.pu-btn-primary { background: var(--dsw-alias-brand-primary, #4d6bfe); border-color: transparent; color: #fff; }
.pu-btn-primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--dsw-alias-brand-primary, #4d6bfe); }
.pu-btn-danger { color: #d33b3b; border-color: rgba(211,59,59,.35); }
.pu-btn-sm { height: 26px; padding: 0 10px; font-size: 12px; }
.pu-banner { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: var(--dsw-radius-md, 8px); background: rgba(255,171,0,.10); border: 1px solid rgba(255,171,0,.35); color: inherit; font-size: 12.5px; }
.pu-banner .pu-spacer { flex: 1; }
.pu-notice { padding: 9px 12px; border-radius: var(--dsw-radius-md, 8px); font-size: 12.5px; }
.pu-notice-error { background: rgba(211,59,59,.09); border: 1px solid rgba(211,59,59,.30); }
.pu-notice-info { background: var(--dsw-alias-bg-subtle, rgba(77,107,254,.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.pu-scroll { overflow-x: auto; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); border-radius: var(--dsw-radius-lg, 12px); }
.pu-table { min-width: 900px; width: 100%; }
.pu-thead, .pu-row { display: grid; grid-template-columns: minmax(200px, 1.6fr) 92px 116px minmax(140px, 1fr) 92px 104px; align-items: center; gap: 12px; padding: 0 14px; }
.pu-thead > div, .pu-row > div { min-width: 0; }
.pu-vercell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pu-verhint { font-size: 10.5px; line-height: 13px; color: #a86b00; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pu-thead { height: 34px; font-size: 12px; color: var(--dsw-alias-text-tertiary, #8f959e); border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); background: var(--dsw-alias-bg-subtle, rgba(0,0,0,.015)); position: sticky; top: 0; }
.pu-row { min-height: 62px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.05)); }
.pu-row:last-child { border-bottom: none; }
.pu-row:hover { background: var(--dsw-alias-bg-hover, rgba(0,0,0,.02)); }
.pu-plugin { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pu-icon { width: 30px; height: 30px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: var(--dsw-alias-bg-subtle, rgba(0,0,0,.04)); }
.pu-icon-fallback { display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; color: var(--dsw-alias-text-secondary, #646a73); }
.pu-names { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pu-title { font-size: 13.5px; font-weight: 600; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pu-pkg { font-size: 11.5px; line-height: 15px; color: var(--dsw-alias-text-tertiary, #8f959e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pu-ver { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-text-secondary, #646a73); white-space: nowrap; }
.pu-ver-next { color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }
.pu-desc { font-size: 12px; color: var(--dsw-alias-text-tertiary, #8f959e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pu-badge { display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 8px; border-radius: 999px; font-size: 11.5px; white-space: nowrap; border: 1px solid transparent; }
.pu-badge-idle { background: var(--dsw-alias-bg-subtle, rgba(0,0,0,.04)); color: var(--dsw-alias-text-tertiary, #8f959e); }
.pu-badge-ok { background: rgba(35,160,90,.12); color: #1f8a4c; }
.pu-badge-new { background: rgba(77,107,254,.12); color: #3f5be0; }
.pu-badge-warn { background: rgba(255,171,0,.14); color: #a86b00; }
.pu-badge-off { background: rgba(0,0,0,.05); color: var(--dsw-alias-text-tertiary, #8f959e); }
.pu-badge-err { background: rgba(211,59,59,.12); color: #c03434; }
.pu-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pu-actions { display: flex; justify-content: flex-end; }
.pu-section { border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.pu-section-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; }
.pu-section-head .pu-hint { font-weight: 400; }
.pu-log { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; }
.pu-log-line { display: flex; gap: 8px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-text-secondary, #646a73); }
.pu-log-time { flex: 0 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-text-tertiary, #8f959e); }
.pu-log-text { min-width: 0; word-break: break-word; }
.pu-log-line.pu-fail .pu-log-text { color: #c03434; }
.pu-log-line.pu-ok .pu-log-text { color: #1f8a4c; }
.pu-empty { padding: 18px; text-align: center; font-size: 12.5px; color: var(--dsw-alias-text-tertiary, #8f959e); }
.pu-progress { height: 3px; border-radius: 2px; background: var(--dsw-alias-bg-subtle, rgba(0,0,0,.06)); overflow: hidden; }
.pu-progress > div { height: 100%; background: var(--dsw-alias-brand-primary, #4d6bfe); transition: width .2s ease; }
.pu-modal-mask { position: fixed; inset: 0; background: rgba(15,18,24,.42); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 24px; }
.pu-modal { width: min(480px, 100%); max-height: 80vh; overflow: auto; background: var(--dsw-alias-bg-elevated, #fff); color: var(--dsw-alias-text-primary, #1f2329); border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,.24); padding: 20px 22px; }
.pu-modal h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.pu-modal p { margin: 0 0 12px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-text-secondary, #4a5058); white-space: pre-wrap; }
.pu-modal-list { margin: 0 0 12px; padding-left: 18px; font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-text-secondary, #4a5058); max-height: 180px; overflow: auto; }
.pu-modal-foot { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.pu-kv { display: flex; gap: 8px; font-size: 12.5px; margin-bottom: 6px; }
.pu-kv b { font-weight: 600; }
`;

    function useStyle() {
      useEffect(() => {
        const id = 'dsh-plugin-updates-css';
        if (document.getElementById(id) !== null) return undefined;
        const node = document.createElement('style');
        node.id = id;
        node.textContent = CSS;
        document.head.appendChild(node);
        return () => { node.remove(); };
      }, []);
    }

    // ------------------------------------------------------------- component

    /** Set by apply(); the tab component reads the services through it. */
    let RUNTIME: any = null;

    function pmCall(method, ...args) {
      const pm = RUNTIME?.pm;
      if (pm === null || pm === undefined || typeof pm[method] !== 'function') {
        return Promise.resolve({ ok: false, error: { code: 'no-manager', message: 'pluginManager unavailable' } });
      }
      try {
        return Promise.resolve(pm[method](...args));
      } catch (error) {
        return Promise.resolve({ ok: false, error: { code: 'throw', message: errorText(error) } });
      }
    }

    /**
     * Mutating RPCs can outlive the tab (switched away, SSE reconnected) and then never
     * settle — which pins the row at 「正在升级中」 forever. Race them with a timer so the
     * UI always gets an answer; the host keeps working either way.
     */
    function pmCallTimed(method, timeoutMs, ...args) {
      return Promise.race([
        pmCall(method, ...args),
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: false, error: { code: 'timeout', message: '' } }), timeoutMs);
        }),
      ]);
    }

    function isLocalPackage(bundle) {
      const source = typeof bundle?.source === 'string' ? bundle.source : '';
      if (/^(link|file|workspace):/i.test(source)) return true;
      return /^link:/i.test(String(bundle?.version ?? ''));
    }

    function shortError(error) {
      const raw = errorText(error);
      const firstLine = raw.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? raw;
      return firstLine.length > 260 ? `${firstLine.slice(0, 260)}…` : firstLine;
    }

    // pnpm writes a long progress log; the actionable line is the one carrying an ERR_ code.
    function pickDiagnosticLine(raw) {
      const lines = String(raw ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const coded = lines.find((line) => /\[ERR_[A-Z0-9_]+\]/.test(line)) ?? lines.find((line) => /^ERR_[A-Z0-9_]+/.test(line));
      if (coded !== undefined) return coded.length > 300 ? `${coded.slice(0, 300)}…` : coded;
      const named = lines.find((line) => /(^|\s)(Error|error):/.test(line));
      if (named !== undefined) return named.length > 300 ? `${named.slice(0, 300)}…` : named;
      const first = lines[0] ?? '';
      return first.length > 300 ? `${first.slice(0, 300)}…` : first;
    }

    // The host folds every failure into a successful RPC reply: { ok: true, value: { application:
    // 'failed', error, packageResult } }. Treating that as success is what made an upgrade look
    // like it ran and then fail with a confusing "already-installed" from the next step.
    function failureOf(reply, t) {
      if (reply === null || reply === undefined) return { code: 'no-reply', message: t('errNoReply') };
      if (reply?.error?.code === 'timeout') return { code: 'timeout', message: t('errTimeout') };
      if (reply.ok !== true) return { code: reply.error?.code ?? 'transport', message: shortError(reply.error) };
      const value = reply.value ?? {};
      if (value.application === 'cancelled') return { code: 'cancelled', message: t('errCancelled') };
      if (value.application !== 'failed' && value.error === undefined) return null;
      const code = value.error?.code ?? 'operation-error';
      const raw = `${value.error?.diagnostic ?? ''}\n${value.packageResult?.output ?? ''}`;
      if (raw.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')) return { code: 'quarantine', message: t('errQuarantine'), raw };
      if (code === 'already-installed') return { code, message: t('errAlreadyInstalled'), raw };
      if (code === 'not-removable') return { code, message: t('errNotRemovable'), raw };
      if (code === 'bundle-in-use') return { code, message: t('errBundleInUse'), raw };
      const line = pickDiagnosticLine(raw);
      return { code, message: line !== '' ? line : t('errUnknown'), raw };
    }

    function currentLocale(props) {
      try {
        const fromCtx = RUNTIME?.ctx?.locale?.getLocale?.();
        const active = fromCtx?.active ?? fromCtx?.locale ?? fromCtx?.id;
        if (typeof active === 'string' && active !== '') return active;
      } catch { /* ignore */ }
      if (typeof props?.locale === 'string' && props.locale !== '') return props.locale;
      try { return navigator.language ?? 'zh'; } catch { return 'zh'; }
    }

    /** Official fallback artwork used by the built-in Plugins page (same SVG as PluginArtworkSubagent). */
    function PluginArtwork(props) {
      const seed = String(props.seed ?? 'plugin');
      let hash = 0;
      for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
      const uid = `pu-art-${hash.toString(36)}`;
      const size = props.size ?? 26;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 36 36', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
      h('rect', { x: '14.9893', y: '15.1877', width: '12.2365', height: '12.2365', rx: '2', fill: `url(#${uid}a)`, fillOpacity: '0.8' }),
      h('rect', { x: '8.87109', y: '9.0697', width: '12.2365', height: '12.2365', rx: '2', fill: `url(#${uid}b)`, fillOpacity: '0.8' }),
      h('defs', null,
        h('linearGradient', { id: `${uid}a`, x1: '21.1075', y1: '15.1877', x2: '21.1075', y2: '27.4243', gradientUnits: 'userSpaceOnUse' },
          h('stop', { stopColor: '#45E7A4' }),
          h('stop', { offset: '1', stopColor: '#05909D' })),
        h('linearGradient', { id: `${uid}b`, x1: '14.9894', y1: '9.0697', x2: '14.9894', y2: '21.3063', gradientUnits: 'userSpaceOnUse' },
          h('stop', { stopColor: '#69B9FF' }),
          h('stop', { offset: '1', stopColor: '#324DE2' }))));
    }

    function Modal(props) {
      const onMask = (event) => {
        if (event.target === event.currentTarget && typeof props.onDismiss === 'function') props.onDismiss();
      };
      return h('div', { className: 'pu-modal-mask', onMouseDown: onMask },
        h('div', { className: 'pu-modal', role: 'dialog', 'aria-modal': 'true' },
          h('h3', null, props.title),
          props.body === undefined || props.body === null || props.body === '' ? null : h('p', null, props.body),
          props.children ?? null,
          h('div', { className: 'pu-modal-foot' }, ...props.actions),
        ),
      );
    }

    function Badge(props) {
      return h('span', {
        className: `pu-badge pu-badge-${props.tone}`,
        title: props.title !== undefined && props.title !== '' ? props.title : undefined,
      }, h('span', { className: 'pu-dot' }), props.label);
    }

    function UpdatesSection(props) {
      useStyle();
      const locale = useMemo(() => currentLocale(props), []);
      const t = useCallback((key, vars) => {
        const table = dict(locale);
        const template = table[key] ?? zh[key] ?? key;
        return vars === undefined ? template : fmt(template, vars);
      }, [locale]);

      const [rows, setRows] = useState([]);
      const [phase, setPhase] = useState('loading');
      const [checkPhase, setCheckPhase] = useState('idle');
      const [checks, setChecks] = useState(() => readCache().results);
      const [checkedAt, setCheckedAt] = useState(() => readCache().at);
      const [busy, setBusy] = useState(null);
      const [batch, setBatch] = useState(null);
      const [notice, setNotice] = useState(null);
      const [dialog, setDialog] = useState(null);
      const [queue, setQueue] = useState({ pending: 0, items: [] });
      const [policy, setPolicy] = useState(null);
      const [hostInfo, setHostInfo] = useState(null);
      const [restarting, setRestarting] = useState(false);
      const [log, setLog] = useState([]);
      const mutating = useRef(false);
      const mounted = useRef(true);
      const seeded = useRef(false);

      useEffect(() => () => { mounted.current = false; }, []);

      const addLog = useCallback((entry) => {
        setLog((prev) => [{ at: new Date().toISOString(), ...entry }, ...prev].slice(0, 60));
      }, []);

      const refresh = useCallback(async () => {
        const res = await pmCall('listBundles');
        if (!mounted.current) return;
        if (res?.ok !== true) {
          setPhase('ready');
          setNotice({ kind: 'error', text: `${t('loadFailed')}: ${shortError(res?.error)}` });
          return;
        }
        const list = Array.isArray(res.value) ? res.value : [];
        setRows(list.filter((item) => item !== null && typeof item === 'object' && item.installed !== false));
        setPhase('ready');
      }, [t]);

      const loadHost = useCallback(async () => {
        const res = await RUNTIME?.host?.state?.();
        if (!mounted.current || res?.ok !== true) return null;
        setHostInfo(res.host ?? null);
        setQueue(res.queue ?? { pending: 0, items: [] });
        if (res.lastRun !== null && res.lastRun !== undefined && seeded.current === false) {
          seeded.current = true;
          const results = Array.isArray(res.lastRun.results) ? res.lastRun.results : [];
          setLog(results.map((item) => ({
            at: res.lastRun.at,
            name: item.name === '*' ? 'system' : item.name,
            kind: item.status === 'upgraded' ? 'ok' : item.status === 'rolled-back' ? 'warn' : 'fail',
            text: `${item.name} ${item.from ?? ''}${item.to ? ` → ${item.to}` : ''} ${item.message ?? ''}`.trim(),
          })));
        }
        return res;
      }, []);

      useEffect(() => {
        void refresh();
        void loadHost();
      }, [refresh, loadHost]);

      useEffect(() => {
        const disposers = [];
        const bump = () => {
          if (mutating.current) return;
          void refresh();
          void loadHost();
        };
        try {
          const off = RUNTIME?.ctx?.remote?.$on?.('plugin-manager/changed', bump);
          if (typeof off === 'function') disposers.push(off);
        } catch { /* event bus optional */ }
        // Switching tabs suspends nothing but the SSE stream may have been reconnected,
        // so a returning tab re-reads instead of trusting its snapshot.
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          if (mutating.current) return;
          void refresh();
          void loadHost();
        };
        document.addEventListener('visibilitychange', onVisible);
        disposers.push(() => document.removeEventListener('visibilitychange', onVisible));
        try {
          const off = RUNTIME?.ctx?.on?.('connection/reset', bump);
          if (typeof off === 'function') disposers.push(off);
        } catch { /* ignore */ }
        return () => {
          for (const off of disposers) { try { off(); } catch { /* ignore */ } }
        };
      }, [refresh, loadHost]);

      // ------------------------------------------------------------ checking

      const checkAll = useCallback(async (fresh) => {
        if (checkPhase === 'checking') return;
        setCheckPhase('checking');
        setNotice(null);
        // A `link:`/`file:` package has no registry copy to compare against, and the
        // row already reads 本地开发 — asking the registry about it only wastes lookups.
        const names = Array.from(new Set([
          ...rows.filter((item) => !isLocalPackage(item)).map((item) => item.name),
          RUNTIME_PACKAGE,
        ]));
        const res = await RUNTIME?.host?.post?.('/check', { names, fresh: fresh === true }, 90000);
        if (!mounted.current) return;
        setCheckPhase('idle');
        if (res?.ok !== true) {
          setNotice({ kind: 'error', text: `${t('checkFailed')}: ${shortError(res?.error)}` });
          return;
        }
        const at = typeof res.checkedAt === 'string' ? res.checkedAt : new Date().toISOString();
        const incoming = (res.results !== null && typeof res.results === 'object' ? res.results : {}) as Record<string, any>;
        setChecks((prev) => {
          const next = { ...prev, ...incoming };
          writeCache(at, next);
          return next;
        });
        setCheckedAt(at);
        const failed = Object.values(incoming).filter((item) => item?.ok === false).length;
        if (failed > 0) setNotice({ kind: 'info', text: t('partial', { n: failed }) });
      }, [checkPhase, rows, t, locale]);

      // ------------------------------------------------------------ upgrading

      const installedVersionOf = useCallback(async (name) => {
        const res = await pmCall('listBundles');
        const list = Array.isArray(res?.value) ? res.value : [];
        const found = list.find((item) => item?.name === name);
        return typeof found?.version === 'string' ? found.version : '';
      }, []);

      const rollback = useCallback(async (name, from, enabled) => {
        if (!isExactVersion(from)) {
          await pmCall('setBundleEnabled', name, enabled);
          return false;
        }
        const res = await pmCallTimed('installBundle', 300000, `${name}@${from}`, { enabled, saveExact: true, requestId: uuid() });
        const ok = res?.ok === true && res?.value?.application !== 'failed';
        if (!ok) await pmCall('setBundleEnabled', name, enabled);
        return ok;
      }, []);

      /** The command a user can paste into a terminal to put a removed plugin back. */
      const recoveryCommand = useCallback((name, from) =>
        (isExactVersion(from) ? `dsh plugin add ${name}@${from}` : `dsh plugin add ${name}`), []);

      // Install one exact version and wait for a lost reply instead of guessing.
      const installWith = useCallback(async (name, to, enabled, approvedBuilds) => {
        const requestId = uuid();
        const options: Record<string, unknown> = { enabled, saveExact: true, requestId };
        if (approvedBuilds !== null && approvedBuilds.length > 0) options.approvedBuilds = approvedBuilds;
        let installed = await pmCallTimed('installBundle', 600000, `${name}@${to}`, options);
        if (installed?.ok !== true && installed?.error?.code !== 'timeout') {
          try {
            const settled = await pmCallTimed('waitForInstall', 600000, requestId);
            if (settled?.ok === true && settled.value !== undefined) installed = { ok: true, value: settled.value };
          } catch { /* the reply may simply be lost */ }
        }
        return installed;
      }, []);

      // Turn one install reply into a row result; `approved` marks a retry after the
      // user allowed the pending build scripts, so a second refusal is a real failure.
      const settleInstall = useCallback(async (name, to, from, enabled, approvedBuilds) => {
        const installed = await installWith(name, to, enabled, approvedBuilds);
        const failure = failureOf(installed, t);
        if (failure !== null) {
          const pending = Array.isArray(installed?.value?.pendingBuilds)
            ? installed.value.pendingBuilds.filter((item) => typeof item === 'string' && item !== '')
            : [];
          if (pending.length > 0 && approvedBuilds === null) {
            return { status: 'builds', pendingBuilds: pending, message: failure.message, code: failure.code };
          }
          // A timed-out install may still be running on the host: rolling back now would
          // race two pnpm runs against each other, so only report it.
          if (failure.code === 'timeout') {
            return { status: 'unknown', message: failure.message, code: 'timeout' };
          }
          const rolled = await rollback(name, from, enabled);
          return { status: 'failed', message: failure.message, code: failure.code, rolledBack: rolled, from };
        }
        const value = installed.value ?? {};
        const nowVersion = await installedVersionOf(name);
        if (nowVersion !== '' && isExactVersion(to) && compareVersions(nowVersion, to) !== 0) {
          return { status: 'failed', message: t('verifyFail'), rolledBack: false, version: nowVersion };
        }
        if (value.application === 'restart-required') {
          return { status: 'restart', message: value.restartReason ?? '', version: nowVersion || to };
        }
        return { status: 'ok', version: nowVersion || to };
      }, [installWith, installedVersionOf, rollback, t]);

      /**
       * Ask the manager whether `name@to` can be installed before anything is
       * removed. Only certain refusals block (a spec the registry cannot
       * resolve); `already-installed` is what the copy we are about to replace
       * reports, and a failed inspection fails open.
       */
      const preflight = useCallback(async (name, to) => {
        try {
          const res = await pmCallTimed('inspect', 60000, name + '@' + to);
          const value = res?.value ?? res;
          if (value?.status === 'refused') {
            const blocking = ['invalid-spec', 'not-found', 'not-a-package', 'not-a-bundle', 'network'];
            if (blocking.includes(value.problem)) return { code: value.problem, message: String(value.reason ?? '') };
          }
          return null;
        } catch {
          return null;
        }
      }, []);

      const upgradeOne = useCallback(async (row) => {
        const name = row.name;
        const to = row.target;
        const from = row.installed;
        const enabled = row.enabled !== false;
        if (typeof to !== 'string' || to === '') return { status: 'failed', message: t('noTarget') };
        mutating.current = true;
        // removeBundle disables the bundle and persists that before it runs pnpm, so any
        // failure after that point leaves the plugin switched off unless we put it back.
        const restore = async () => {
          if (!enabled) return;
          try { await pmCall('setBundleEnabled', name, true); } catch { /* best effort */ }
        };
        try {
          // Upgrading is remove-then-install, so an unresolvable target must be
          // caught before the installed copy is taken away.
          const refused = await preflight(name, to);
          if (refused !== null) {
            return { status: 'failed', stage: 'preflight', code: refused.code, message: refused.message || t('preflightRefused') };
          }
          const removed = await pmCallTimed('removeBundle', 300000, name);
          const removeFailure = failureOf(removed, t);
          if (removeFailure !== null) {
            // Both codes mean the bundle cannot be unloaded in this process: the host
            // disables it and refuses, so the only way to finish is to come back up
            // without it loaded. `stop-profile` is what a profile without HMR says.
            if (removeFailure.code === 'bundle-in-use' || removeFailure.code === 'stop-profile') {
              const prepared = await RUNTIME?.host?.post?.('/prepare', {
                trigger: 'restart',
                items: [{ name, from, to, wasEnabled: enabled }],
              }, 30000);
              if (prepared?.ok === true) return { status: 'restart', message: t('restartQueued') };
              await restore();
              return { status: 'failed', message: shortError(prepared?.error) };
            }
            await restore();
            return { status: 'failed', message: removeFailure.message, code: removeFailure.code };
          }
          return await settleInstall(name, to, from, enabled, null);
        } catch (error) {
          return { status: 'failed', message: shortError(error) };
        } finally {
          mutating.current = false;
        }
      }, [preflight, settleInstall, t]);

      const applyResult = useCallback((name, result) => {
        if (result.status !== 'ok' || typeof result.version !== 'string' || result.version === '') return;
        // The install RPC already returned the version it put on disk; show it immediately so a
        // listBundles call that lands a moment too early cannot leave the old version on screen.
        setRows((prev) => prev.map((row) => (row.name === name ? { ...row, version: result.version } : row)));
        setChecks((prev) => {
          const next = { ...prev, [name]: { ...(prev[name] ?? {}), ok: true, installed: result.version } };
          // Write through: switching tabs remounts this section, and a stale cache would
          // otherwise resurrect the pre-upgrade version and its phantom upgrade offer.
          const cache = readCache();
          writeCache(cache.at ?? new Date().toISOString(), next);
          return next;
        });
      }, []);

      // Shared tail: log the outcome, refresh, then open the follow-up dialog.
      const settleRow = useCallback(async (row, result) => {
        applyResult(row.name, result);
        addLog({
          name: row.title,
          kind: result.status === 'ok' ? 'ok' : result.status === 'restart' ? 'warn' : 'fail',
          text: `${row.title} ${row.installed || row.version || ''} → ${row.target}` +
            (result.status === 'ok' ? '' : ` · ${result.message ?? ''}`),
        });
        if (result.code === 'quarantine') setPolicy({ message: result.message ?? '' });
        let pending = 0;
        try { await refresh(); } catch { /* keep going */ }
        try { const state = await loadHost(); pending = state?.queue?.pending ?? 0; } catch { /* keep going */ }
        if (result.status === 'restart') {
          setDialog({ kind: 'restart', count: pending });
        } else if (result.status === 'failed' && result.rolledBack === true) {
          // The old version is back on disk: say so, otherwise the row looks broken.
          setNotice({ kind: 'info', text: `${row.title}: ${result.message} · ${t('rolledBack', { version: result.from ?? row.installed })}` });
        } else if (result.status === 'failed' && result.stage === 'install') {
          // Removal worked, the install did not, and the rollback did not either — the
          // package is gone from the profile, so hand the user the way back.
          setNotice({ kind: 'error', text: `${row.title}: ${t('failRemoved')} · ${result.message} · ${t('recoveryHint', { cmd: recoveryCommand(row.name, result.from ?? row.installed) })}` });
        } else if (result.status === 'failed') {
          setNotice({ kind: 'error', text: `${row.title}: ${result.message}` });
        } else if (result.status === 'unknown') {
          setNotice({ kind: 'info', text: `${row.title}: ${result.message}` });
        }
      }, [addLog, applyResult, loadHost, recoveryCommand, refresh, t]);

      const upgradeRow = useCallback(async (row) => {
        setNotice(null);
        setBusy(row.name);
        const result = await upgradeOne(row);
        setBusy(null);
        if (result.status === 'builds') {
          setDialog({ kind: 'builds', row, pending: result.pendingBuilds });
          return;
        }
        await settleRow(row, result);
      }, [settleRow, upgradeOne]);

      // The user allowed the pending build scripts: reinstall with that approval.
      const approveBuilds = useCallback(async (row, pending) => {
        setDialog(null);
        setBusy(row.name);
        const result = await settleInstall(row.name, row.target, row.installed, row.enabled !== false, pending);
        setBusy(null);
        if (result.status === 'builds') {
          await rollback(row.name, row.installed, row.enabled !== false);
          setNotice({ kind: 'error', text: `${row.title}: ${t('buildSkipped')}` });
          return;
        }
        await settleRow(row, result);
      }, [rollback, settleInstall, settleRow, t]);

      // Declining the build scripts is a deliberate skip, not a failure — but the old
      // version was already removed, so put it back before reporting the skip.
      const skipBuilds = useCallback(async (row) => {
        setDialog(null);
        setBusy(row.name);
        await rollback(row.name, row.installed, row.enabled !== false);
        setBusy(null);
        addLog({ name: row.title, kind: 'warn', text: `${row.title} · ${t('buildSkipped')}` });
        try { await refresh(); } catch { /* keep going */ }
      }, [addLog, refresh, rollback, t]);

      const fixPolicy = useCallback(async (minutes) => {
        setDialog(null);
        try {
          const reply = await RUNTIME?.host?.post?.('/policy', { minutes }, 15000);
          if (reply?.ok === true) {
            setPolicy(null);
            setNotice({ kind: 'info', text: t('policyFixed', { minutes: reply.minutes ?? minutes }) });
            try { await loadHost(); } catch { /* keep going */ }
          } else {
            setNotice({ kind: 'error', text: shortError(reply?.error) });
          }
        } catch (error) {
          setNotice({ kind: 'error', text: shortError(error) });
        }
      }, [loadHost, t]);

      const startBatch = useCallback(async (targets) => {
        setDialog(null);
        setNotice(null);
        const results = [];
        try {
          for (let index = 0; index < targets.length; index += 1) {
            const row = targets[index];
            setBatch({ total: targets.length, done: index, name: row.title });
            setBusy(row.name);
            const result = await upgradeOne(row);
            setBusy(null);
            if (result.status === 'builds') {
              await rollback(row.name, row.installed, row.enabled !== false);
              addLog({ name: row.title, kind: 'warn', text: `${row.title} · ${t('buildSkipped')}` });
              results.push({ row, result: { status: 'skipped', message: t('buildSkipped') } });
              continue;
            }
            applyResult(row.name, result);
            addLog({
              name: row.title,
              kind: result.status === 'ok' ? 'ok' : result.status === 'restart' ? 'warn' : 'fail',
              text: `${row.title} ${row.installed || row.version || ''} → ${row.target}` +
                (result.status === 'ok' ? '' : ` · ${result.message ?? ''}`),
            });
            results.push({ row, result });
          }
        } finally {
          setBatch(null);
          setBusy(null);
          // The summary dialog must appear even when the follow-up refresh fails.
          try { await refresh(); } catch { /* keep going */ }
          let pending = 0;
          try { const state = await loadHost(); pending = state?.queue?.pending ?? 0; } catch { /* keep going */ }
          setDialog({
            kind: 'summary',
            ok: results.filter((item) => item.result.status === 'ok').length,
            restart: results.filter((item) => item.result.status === 'restart').length,
            pending,
            skipped: results.filter((item) => item.result.status === 'skipped').length,
            failed: results.filter((item) => item.result.status === 'failed')
              .map((item) => ({
                name: item.row.title,
                message: item.result.message ?? '',
                // Removal succeeded and the rollback did not: the package is gone,
                // so the summary has to carry the way back.
                cmd: item.result.stage === 'install' && item.result.rolledBack !== true
                  ? recoveryCommand(item.row.name, item.result.from ?? item.row.installed)
                  : '',
              })),
          });
        }
      }, [addLog, applyResult, loadHost, recoveryCommand, refresh, rollback, t, upgradeOne]);

      const doRestart = useCallback(async () => {
        setDialog(null);
        setRestarting(true);
        setNotice(null);
        const before = await RUNTIME?.host?.state?.();
        const nonceBefore = before?.host?.nonce;
        const res = await RUNTIME?.host?.post?.('/restart', {}, 25000);
        if (res?.ok !== true) {
          setRestarting(false);
          setNotice({ kind: 'error', text: shortError(res?.error) });
          return;
        }
        const started = Date.now();
        const tick = async () => {
          if (!mounted.current) return;
          if (Date.now() - started > 150000) {
            setRestarting(false);
            setNotice({ kind: 'error', text: t('restartTimeout') });
            return;
          }
          const state = await RUNTIME?.host?.state?.();
          const fresh = nonceBefore === undefined || state?.host?.nonce !== nonceBefore;
          if (state?.ok === true && fresh && Date.now() - started > 1200) {
            window.setTimeout(() => window.location.reload(), 1200);
            return;
          }
          window.setTimeout(() => { void tick(); }, 1500);
        };
        window.setTimeout(() => { void tick(); }, 3000);
      }, [t]);

      const cancelQueue = useCallback(async () => {
        setDialog(null);
        const res = await RUNTIME?.host?.post?.('/cancel', {}, 40000);
        if (res?.ok !== true) setNotice({ kind: 'error', text: shortError(res?.error) });
        await refresh();
        await loadHost();
      }, [loadHost, refresh]);

      // -------------------------------------------------------------- rows

      const pendingNames = useMemo(() => {
        const items = Array.isArray(queue.items) ? queue.items : [];
        return new Set(items.filter((item) => item?.phase === 'pending').map((item) => item.name));
      }, [queue]);

      const policyMinutes = typeof hostInfo?.policy === 'number' ? hostInfo.policy : null;
      const model = useMemo(() => {
        const list = rows.map((bundle) => {
          const meta = bundle.meta !== null && typeof bundle.meta === 'object' ? bundle.meta : {};
          const title = pickText(meta.title) || displayName(bundle.name);
          const description = pickText(meta.description);
          const icon = typeof meta.icon === 'string' ? meta.icon : '';
          // The live profile manifest wins: a cached check records the version that was
          // installed when the check ran, which is stale the moment an upgrade lands.
          const liveVersion = typeof bundle.version === 'string' ? bundle.version : '';
          const cached = checks[bundle.name];
          // A check whose recorded version disagrees with the profile is stale — drop it
          // so the row reads 未检测 instead of advertising an upgrade that already happened.
          const check = cached !== undefined && (
            typeof cached.installed !== 'string'
            || cached.installed === ''
            || liveVersion === ''
            || cached.installed === liveVersion
          ) ? cached : undefined;
          const local = isLocalPackage(bundle);
          const official = bundle.official === true;
          const removable = bundle.removable !== false;
          const installed = liveVersion !== ''
            ? liveVersion
            : (typeof cached?.installed === 'string' ? cached.installed : '');
          const latest = check !== undefined && check.ok === true && typeof check.latest === 'string' ? check.latest : '';
          const publishedAt = typeof check?.publishedAt === 'string' ? check.publishedAt : null;
          // Follow the profile's real pnpm policy when the host reports one.
          const windowMs = policyMinutes === null ? QUARANTINE_MS : policyMinutes * 60000;
          const quarantined = policyMinutes !== 0 && publishedAt !== null && Date.now() - new Date(publishedAt).getTime() < windowMs;
          let status = 'unchecked';
          let target = '';
          if (busy === bundle.name) {
            status = 'busy';
          } else if (pendingNames.has(bundle.name)) {
            status = 'restart';
            target = typeof check?.latest === 'string' ? check.latest : '';
          } else if (local) {
            status = 'local';
          } else if (official && !removable) {
            status = 'image';
          } else if (checkPhase === 'checking') {
            status = 'checking';
          } else if (check === undefined) {
            status = 'unchecked';
          } else if (check.ok !== true) {
            status = 'unknown';
          } else if (latest !== '' && installed !== '' && compareVersions(latest, installed) !== null && compareVersions(latest, installed) > 0) {
            // pnpm would refuse this install: skip it instead of failing the whole run.
            if (quarantined) {
              status = 'skipped';
            } else {
              status = 'outdated';
            }
            target = latest;
          } else if (latest !== '' && installed !== '' && compareVersions(latest, installed) !== null) {
            status = 'latest';
          } else {
            status = 'unknown';
          }
          return {
            name: bundle.name,
            title,
            description,
            icon,
            version: bundle.version,
            source: typeof bundle.source === 'string' ? bundle.source : '',
            installed,
            latest,
            target,
            status,
            enabled: bundle.enabled !== false,
            official,
            removable,
            checkError: check?.ok === false ? shortError(check.error) : '',
            quarantined,
            quarantineLabel: windowMs >= 3600000 ? `${Math.round(windowMs / 3600000)}h` : `${Math.round(windowMs / 60000)}m`,
          };
        });
        const rank = { busy: 0, restart: 1, outdated: 2, latest: 3, unchecked: 4, unknown: 5, image: 6, local: 7 };
        return list.sort((left, right) => {
          const delta = (rank[left.status] ?? 9) - (rank[right.status] ?? 9);
          if (delta !== 0) return delta;
          return left.title.localeCompare(right.title, locale.startsWith('zh') ? 'zh' : 'en');
        });
      }, [busy, checkPhase, checks, locale, pendingNames, policyMinutes, rows]);

      const outdated = useMemo(() => model.filter((row) => row.status === 'outdated'), [model]);

      // Copy the raw inputs the table was built from — the fastest way to explain a row
      // that reads 本地开发 or 可升级 without matching the profile.
      const copyDiagnostics = useCallback(async () => {
        const payload = model.map((row) => ({
          name: row.name,
          source: row.source,
          version: row.version,
          installed: row.installed,
          latest: row.latest,
          status: row.status,
          official: row.official,
          removable: row.removable,
        }));
        const text = JSON.stringify({ at: new Date().toISOString(), rows: payload }, null, 2);
        try { console.log('[plugin-updates] diagnostics', payload); } catch { /* ignore */ }
        try {
          await navigator.clipboard.writeText(text);
          setNotice({ kind: 'info', text: t('diagnoseCopied', { n: payload.length }) });
        } catch {
          setNotice({ kind: 'info', text });
        }
      }, [model, t]);

      const runtimeCheck = checks[RUNTIME_PACKAGE];
      const runtimeLatest = runtimeCheck?.ok === true && typeof runtimeCheck.latest === 'string' ? runtimeCheck.latest : '';
      const runtimeCurrent = hostInfo?.runtimeVersion ?? '';
      const runtimeBehind = runtimeLatest !== '' && runtimeCurrent !== '' && compareVersions(runtimeLatest, runtimeCurrent) !== null && compareVersions(runtimeLatest, runtimeCurrent) > 0;

      const statusLabel = useCallback((row) => {
        switch (row.status) {
          case 'busy': return { tone: 'new', label: t('upgrading') };
          case 'checking': return { tone: 'idle', label: t('checking') };
          case 'restart': return { tone: 'warn', label: t('statusRestart') };
          case 'outdated': return { tone: 'new', label: t('statusOutdated') };
          case 'skipped': return { tone: 'warn', label: t('statusSkipped') };
          case 'latest': return { tone: 'ok', label: t('statusLatest') };
          case 'image': return { tone: 'off', label: t('statusImage') };
          case 'local': return { tone: 'off', label: t('statusLocal') };
          case 'unknown': return { tone: 'err', label: t('statusUnknown') };
          default: return { tone: 'idle', label: t('statusUnchecked') };
        }
      }, [t]);

      // ------------------------------------------------------------- render

      const policyLabel = policyMinutes === null
        ? '24h'
        : policyMinutes === 0 ? t('policyOff') : (policyMinutes >= 120 ? `${Math.round(policyMinutes / 60)}h` : `${policyMinutes}m`);
      const toolbar = h('div', { className: 'pu-bar' },
        h('button', {
          className: `pu-btn ${checkedAt === null ? 'pu-btn-primary' : ''}`,
          disabled: checkPhase === 'checking' || phase !== 'ready',
          onClick: () => { void checkAll(true); },
        }, checkPhase === 'checking' ? t('checking') : t('check')),
        h('button', {
          className: 'pu-btn pu-btn-primary',
          disabled: outdated.length === 0 || busy !== null || batch !== null || checkPhase === 'checking',
          onClick: () => setDialog({ kind: 'batch', targets: outdated }),
        }, `${t('upgradeAll')}${outdated.length > 0 ? ` (${outdated.length})` : ''}`),
        h('button', {
          className: 'pu-btn',
          disabled: phase !== 'ready',
          onClick: () => { void refresh(); void loadHost(); },
        }, t('refresh')),
        queue.pending > 0
          ? h('button', { className: 'pu-btn pu-btn-danger', disabled: restarting, onClick: () => setDialog({ kind: 'restart', count: queue.pending }) },
            restarting ? t('restarting') : t('headerRestart'))
          : null,
        h('button', {
          className: 'pu-btn',
          disabled: phase !== 'ready',
          title: t('policyTitle'),
          onClick: () => setDialog({ kind: 'policy' }),
        }, `${t('policyEntry')} ${policyLabel}`),
        h('button', {
          className: 'pu-btn',
          disabled: phase !== 'ready' || model.length === 0,
          title: t('diagnoseTitle'),
          onClick: () => { void copyDiagnostics(); },
        }, t('diagnose')),
        h('span', { className: 'pu-spacer' }),
        h('span', { className: 'pu-hint' },
          checkedAt === null
            ? t('never')
            : `${t('lastChecked', { time: fmtClock(checkedAt) })} · ${t('summaryLine', { outdated: outdated.length, total: model.length })}`),
        h('span', {
          className: 'pu-hint',
          title: `client ${CLIENT_VERSION} · host ${typeof hostInfo?.version === 'string' ? hostInfo.version : '?'}`,
        }, `v${CLIENT_VERSION}`),
      );

      const banners = [];
      if (queue.pending > 0) {
        banners.push(h('div', { className: 'pu-banner', key: 'queue' },
          h('span', null, `⏳ ${t('queueBanner', { n: queue.pending })}`),
          h('span', { className: 'pu-spacer' }),
          h('button', { className: 'pu-btn pu-btn-sm pu-btn-primary', disabled: restarting, onClick: () => setDialog({ kind: 'restart', count: queue.pending }) }, t('headerRestart')),
          h('button', { className: 'pu-btn pu-btn-sm', disabled: restarting, onClick: () => setDialog({ kind: 'cancelQueue' }) }, t('queueCancel')),
        ));
      }
      if (runtimeBehind) {
        banners.push(h('div', { className: 'pu-banner', key: 'runtime' },
          h('span', null, `🚀 ${t('runtimeOutdated', { latest: runtimeLatest, current: runtimeCurrent })}`),
        ));
      }
      if (policy !== null) {
        banners.push(h('div', { className: 'pu-banner', key: 'policy' },
          h('span', null, `\u26a0\ufe0f ${t('policyHint')}`),
          h('span', { className: 'pu-spacer' }),
          h('button', { className: 'pu-btn pu-btn-sm pu-btn-primary', onClick: () => setDialog({ kind: 'policy' }) }, t('fixPolicy')),
          h('button', { className: 'pu-btn pu-btn-sm', onClick: () => setPolicy(null) }, t('gotIt')),
        ));
      }
      if (batch !== null) {
        const percent = batch.total === 0 ? 0 : Math.round((batch.done / batch.total) * 100);
        banners.push(h('div', { className: 'pu-notice pu-notice-info', key: 'batch' },
          h('div', { style: { marginBottom: '6px' } }, t('progress', { name: batch.name, done: Math.min(batch.done + 1, batch.total), total: batch.total })),
          h('div', { className: 'pu-progress' }, h('div', { style: { width: `${percent}%` } })),
        ));
      }

      const rowView = (row) => {
        const badge = statusLabel(row);
        const icon = row.icon !== ''
          ? h('img', { className: 'pu-icon', src: row.icon, alt: '' })
          : h('div', { className: 'pu-icon pu-icon-fallback' }, h(PluginArtwork, { seed: row.name, size: 26 }));
        let action = null;
        if (row.status === 'busy') {
          action = h('button', { className: 'pu-btn pu-btn-sm', disabled: true }, t('upgrading'));
        } else if (row.status === 'restart') {
          action = h('button', { className: 'pu-btn pu-btn-sm pu-btn-primary', disabled: restarting, onClick: () => setDialog({ kind: 'restart', count: queue.pending }) }, t('restart'));
        } else if (row.status === 'outdated') {
          action = h('button', { className: 'pu-btn pu-btn-sm pu-btn-primary', disabled: busy !== null || batch !== null, onClick: () => { void upgradeRow(row); } }, t('upgrade'));
        } else if (row.status === 'skipped') {
          action = h('button', { className: 'pu-btn pu-btn-sm', disabled: true, title: t('skipNote', { window: row.quarantineLabel }) }, t('statusSkipped'));
        } else if (row.status === 'latest') {
          action = h('button', { className: 'pu-btn pu-btn-sm', disabled: true }, t('statusLatest'));
        } else if (row.status === 'image') {
          action = h('button', { className: 'pu-btn pu-btn-sm', disabled: true, title: t('imageNote') }, t('statusImage'));
        } else if (row.status === 'local') {
          action = h('button', { className: 'pu-btn pu-btn-sm', disabled: true, title: t('localNote') }, t('statusLocal'));
        } else {
          action = h('button', { className: 'pu-btn pu-btn-sm', disabled: checkPhase === 'checking' || phase !== 'ready', onClick: () => { void checkAll(true); } }, t('check'));
        }
        return h('div', { className: 'pu-row', key: row.name },
          h('div', { className: 'pu-plugin' },
            icon,
            h('div', { className: 'pu-names' },
              h('div', { className: 'pu-title', title: row.title },
                typeof props?.openPackage === 'function'
                  ? h('span', {
                    role: 'button',
                    tabIndex: 0,
                    style: { cursor: 'pointer' },
                    onClick: () => props.openPackage(row.name),
                  }, row.title)
                  : row.title,
                row.enabled === false ? h('span', { className: 'pu-badge pu-badge-off', style: { marginLeft: '6px' } }, t('statusDisabled')) : null,
              ),
              h('div', { className: 'pu-pkg', title: row.name }, row.name),
            ),
          ),
          h('div', { className: 'pu-ver' }, row.installed === '' ? '—' : row.installed),
          h('div', { className: 'pu-vercell' },
            h('div', { className: 'pu-ver' + (row.status === 'outdated' || row.status === 'restart' ? ' pu-ver-next' : '') },
              row.status === 'outdated' && row.target !== '' ? row.target
                : row.status === 'restart' && row.target !== '' ? row.target
                  : row.status === 'image' ? (runtimeCurrent || '—')
                    : '—'),
            row.quarantined ? h('div', { className: 'pu-verhint', title: t('quarantine') }, t('quarantineShort', { window: row.quarantineLabel })) : null,
          ),
          h('div', { className: 'pu-desc', title: row.description }, row.description !== '' ? row.description : '—'),
          h('div', null, h(Badge, {
            tone: badge.tone,
            label: badge.label,
            title: row.source !== '' ? `${row.name}\n${row.source}` : row.name,
          })),
          h('div', { className: 'pu-actions' }, action),
        );
      };

      const table = h('div', { className: 'pu-scroll' },
        h('div', { className: 'pu-table' },
          h('div', { className: 'pu-thead' },
            h('div', null, t('colPlugin')),
            h('div', null, t('colCurrent')),
            h('div', null, t('colLatest')),
            h('div', null, t('colDesc')),
            h('div', null, t('colStatus')),
            h('div', { style: { textAlign: 'right' } }, t('colAction')),
          ),
          model.length === 0
            ? h('div', { className: 'pu-empty' }, phase === 'loading' ? t('checking') : t('noRecords'))
            : model.map(rowView),
        ),
      );

      const logLines = log.length === 0
        ? h('div', { className: 'pu-empty' }, t('noRecords'))
        : h('div', { className: 'pu-log' }, log.map((line, index) => h('div', {
          className: `pu-log-line ${line.kind === 'fail' ? 'pu-fail' : line.kind === 'ok' ? 'pu-ok' : ''}`,
          key: `${line.at}-${index}`,
        },
        h('span', { className: 'pu-log-time' }, fmtDateTime(line.at)),
        h('span', { className: 'pu-log-text' }, line.text),
        )));

      const records = h('div', { className: 'pu-section' },
        h('div', { className: 'pu-section-head' },
          h('span', null, t('records')),
          h('span', { className: 'pu-hint' }, `${model.length} · ${outdated.length}`),
          h('span', { className: 'pu-spacer', style: { flex: 1 } }),
          log.length > 0 ? h('button', {
            className: 'pu-btn pu-btn-sm',
            onClick: () => { setLog([]); void RUNTIME?.host?.post?.('/ack', {}); },
          }, t('clearRecords')) : null,
        ),
        logLines,
      );

      // ------------------------------------------------------------ dialogs

      let modal = null;
      if (dialog !== null) {
        if (dialog.kind === 'batch') {
          const targets = dialog.targets ?? [];
          modal = h(Modal, {
            title: t('batchTitle'),
            body: t('batchBody', { n: targets.length, list: targets.map((row) => `${row.title} (${row.installed} → ${row.target})`).join('\n') }),
            onDismiss: () => setDialog(null),
            actions: [
              h('button', { className: 'pu-btn', key: 'c', onClick: () => setDialog(null) }, t('cancel')),
              h('button', { className: 'pu-btn pu-btn-primary', key: 's', onClick: () => { void startBatch(targets); } }, t('start')),
            ],
          });
        } else if (dialog.kind === 'builds') {
          const pending = dialog.pending ?? [];
          modal = h(Modal, {
            title: t('buildTitle'),
            body: t('buildBody', { list: pending.join('\n'), n: pending.length }),
            onDismiss: () => { void skipBuilds(dialog.row); },
            actions: [
              h('button', { className: 'pu-btn', key: 's', onClick: () => { void skipBuilds(dialog.row); } }, t('buildSkip')),
              h('button', { className: 'pu-btn pu-btn-primary', key: 'a', onClick: () => { void approveBuilds(dialog.row, pending); } }, t('buildApprove')),
            ],
          });
        } else if (dialog.kind === 'restart') {
          modal = h(Modal, {
            title: t('restartTitle'),
            body: t('restartBody', { n: dialog.count ?? queue.pending ?? 1 }),
            onDismiss: () => setDialog(null),
            actions: [
              h('button', { className: 'pu-btn', key: 'l', onClick: () => setDialog(null) }, t('restartLater')),
              h('button', { className: 'pu-btn pu-btn-primary', key: 'r', onClick: () => { void doRestart(); } }, t('restartNow')),
            ],
          });
        } else if (dialog.kind === 'summary') {
          const failed = Array.isArray(dialog.failed) ? dialog.failed : [];
          modal = h(Modal, {
            title: t('summaryTitle'),
            body: [
              t('summaryOk', { n: dialog.ok ?? 0 }),
              t('summaryFail', { n: failed.length }),
              (dialog.pending ?? 0) > 0 ? t('summaryRestart', { n: dialog.pending }) : '',
              (dialog.skipped ?? 0) > 0 ? t('summarySkipped', { n: dialog.skipped }) : '',
            ].filter((line) => line !== '').join(' · '),
            onDismiss: () => setDialog(null),
            actions: [
              (dialog.pending ?? 0) > 0
                ? h('button', { className: 'pu-btn', key: 'l', onClick: () => setDialog(null) }, t('restartLater'))
                : null,
              (dialog.pending ?? 0) > 0
                ? h('button', { className: 'pu-btn pu-btn-primary', key: 'r', onClick: () => { void doRestart(); } }, t('restartNow'))
                : h('button', { className: 'pu-btn pu-btn-primary', key: 'ok', onClick: () => setDialog(null) }, t('gotIt')),
            ].filter(Boolean),
          },
          failed.length === 0 ? null : h('ul', { className: 'pu-modal-list' },
            failed.map((item, index) =>
              h('li', { key: index }, `${item.name}: ${item.message}${item.cmd ? ` · ${t('recoveryHint', { cmd: item.cmd })}` : ''}`))),
          );
        } else if (dialog.kind === 'policy') {
          const current = policyMinutes === null ? 1440 : policyMinutes;
          modal = h(Modal, {
            title: t('policyTitle'),
            body: [
              h('div', { key: 'cur' }, `${t('policyCurrent')} ${current === 0 ? t('policyOff') : (current >= 120 ? `${Math.round(current / 60)}h` : `${current}m`)}${hostInfo?.policyExplicit === true ? '' : ` · ${t('policyDefault')}`}`),
              h('div', { key: 'hint', style: { marginTop: '8px', color: 'var(--dsw-alias-text-3, #888)' } }, t('policyHint')),
              h('div', { key: 'file', style: { marginTop: '8px', fontFamily: 'monospace', fontSize: '12px' } }, hostInfo?.policyFile ?? 'pnpm-workspace.yaml'),
            ],
            onDismiss: () => setDialog(null),
            actions: [
              h('button', { className: 'pu-btn', key: 'c', onClick: () => setDialog(null) }, t('cancel')),
              h('button', { className: 'pu-btn', key: '1440', onClick: () => { void fixPolicy(1440); } }, '24h'),
              h('button', { className: 'pu-btn', key: '360', onClick: () => { void fixPolicy(360); } }, '6h'),
              h('button', { className: 'pu-btn', key: '60', onClick: () => { void fixPolicy(60); } }, '1h'),
              h('button', { className: 'pu-btn pu-btn-primary', key: '0', onClick: () => { void fixPolicy(0); } }, t('policyOff')),
            ],
          });
        } else if (dialog.kind === 'cancelQueue') {
          modal = h(Modal, {
            title: t('queueCancel'),
            body: t('restoreHint'),
            onDismiss: () => setDialog(null),
            actions: [
              h('button', { className: 'pu-btn', key: 'c', onClick: () => setDialog(null) }, t('cancel')),
              h('button', { className: 'pu-btn pu-btn-danger', key: 'x', onClick: () => { void cancelQueue(); } }, t('queueCancel')),
            ],
          });
        }
      }

      return h('div', { className: 'pu-wrap' },
        toolbar,
        ...banners,
        notice === null ? null : h('div', { className: `pu-notice pu-notice-${notice.kind === 'error' ? 'error' : 'info'}` }, notice.text),
        table,
        records,
        modal,
      );
    }

    // ------------------------------------------------------------ registration

    function apply(ctx) {
      const pm = ctx.remote?.pluginManager ?? null;
      RUNTIME = { ctx, pm, host: makeHost() };
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-updates: locale');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('plugins.tab', () => ctx.slots.register({
        name: 'plugins.tab',
        id: 'updates',
        order: 1,
        label: () => t('title'),
        locale: NS,
      }, UpdatesSection));
    }

    return { inject, apply };
  },
});

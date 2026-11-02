# 更新日志

## 0.8.0 — 2026-11-02

首个公开发布准备的版本。相对 0.7.1 的改动全部来自一次发布前代码审查。

### 修复

- **升级前预检**：`upgrade()` 先 `inspect(name@to)`，目标版本解析不到、不是包、不是 bundle、
  注册表不可达时直接取消，**不动已安装的版本**（以前会先卸载再失败）。
- **卸载后装不上有明确出路**：`settleInstall` 区分「已回滚」与「已卸载且没装回来」，
  后者在提示和批量结果弹窗里直接给出 `dsh plugin add <name>@<version>` 恢复命令。
- **队列写不进去时不再停用插件**：`/prepare` 在 `stateFile() === null` 时先拒绝
  （`no-queue`）；写盘失败会把刚停用的插件全部恢复启用。
- **`stop-profile` 也能排队重启**：无 HMR 的部署里 `removeBundle` 返回 `stop-profile`，
  以前只报错，现在和 `bundle-in-use` 一样转成「排队 → 重启后完成」。
- **重启不会永久 409**：`restart()` 的 `restarting` 标志 20 秒后自动解除
  （`RESTART_HOLD_MS`），进程没退出时用户可以再点一次。
- **`/policy` 校验**：`minutes` 必须是 0–10080 的整数，否则 400；没有
  `pnpm-workspace.yaml` 时返回 409 `no-policy-file`，**不再新建该文件**；改写前留 `.bak`。
- **非首屏竞态**：`makeHost().post()` 在 nonce 为空时先取 `/state`，遇到 `stale-nonce`
  自动重试一次；`checkAll` 不再对 `link:` 本地包查注册表。
- **版本只写一处**：`package.json` 的 version 由 esbuild 的 `__PU_VERSION__` 注入到
  host 与 client 两个包，工具栏和 `/state` 不再各自硬编码。

### 移除

- 调试残留：`GET /state?probe=1`（曾硬编码 `billion-context`）、`repair()` 函数。
- 客户端不可达的 `/repair`、`/resume` 两个 HTTP 路由（`KNOWN_ROUTES`）。
- 12 个未被引用的 i18n key（如 `noteOutdated`、`statusNote`、`summaryBuildSkipped`），
  新增 `recoveryHint`、`preflightRefused`。

### 变更

- `package.json`：去掉 `private`，补 `license`/`author`/`repository`/`homepage`/`bugs`/
  `keywords`/`engines`，`files` 增加 `LICENSE`、`CHANGELOG.md`，脚本增加 `test`/`check`/
  `prepublishOnly`。
- `tsconfig.json`：开启 `strictFunctionTypes`、`strictBindCallApply`、
  `noFallthroughCasesInSwitch`（`strict` 仍关闭，理由见文件内注释）。
- `installedRoots()` 不再回退到 `process.cwd()`，只用 profile 目录与 `DSH_PROFILE_DIR`。
- 新增宿主端测试 `test/host-routes.cjs`（路由、鉴权头、版本注入、`/policy` 校验、
  队列续做、预检被拒不动已装版本），并入 `npm test` / `npm run check`。

# DSH 已安装插件升级管理（dsh-plugin-updates）

给 DSH 的「已安装插件」加一个 **更新** 标签页：手动检测、单个升级、一键全部升级、失败自动回滚；运行中换不掉的插件改为「重启并升级」——排队、重启 DSH 进程、启动后自动续做。

- 形态：**内置插件页内的一个标签页**（`plugins.tab` 槽位），不是独立页面，所以**不需要**侧边栏入口。
- 组成：`client.js`（UI）+ `index.js`（宿主端：队列落盘、进程重启、开机续做）+ `cordis.patch.yml`。所有插件装卸仍然只走 DSH 自带的 `pluginManager` 远程服务，宿主端不碰 profile 文件。
- 位置：`/volume5/APP/程序库/AI工具类/DSH插件/dsh-plugin-update`（以 `link:` 依赖链进 profile，改文件即热更；**宿主端改动要重启 DSH 才生效**）。

---

## 一、调研结论（对应需求 4）

| 需求 | 能否在 DSH 自带插件页实现 | 实现方式 |
| --- | --- | --- |
| 一键全部升级 | 能 | 「更新」标签页顶部按钮（串行 + 汇总） |
| 单插件升级按钮 | 能 | 每行「升级」按钮（内置 Installed 列表的行是宿主自己的，第三方不能往里插按钮；`plugins.detail.actions` 只能加在“包详情页”头部） |
| 手动检测是否有更新 | 能 | 「检测更新」按钮，无后台定时器 |
| 升级后需要重启 | 能（宿主端自建） | 单行按钮变「重启并升级」；批量结束后统一弹窗询问 |
| 侧边栏入口 | **不需要** | 功能已并入内置插件页，没有新建独立页面 |

内置插件页本来就提供 `plugins.tab` / `plugins.detail.actions` / `plugins.detail.badge` / `plugins.detail.section` 四个扩展点。内置 UI 自带的「更新」按钮只对**官方目录里、且带 installTarget 的包**出现，且没有批量检测/批量升级/重启——这正是本插件补的空白。

## 二、架构

```
浏览器（React 组件，跑在 Web 壳里）
  ├─ ctx.remote.pluginManager.listBundles()       → 已装包、版本、removable、installTarget、meta(图标/中文名/简介)
  ├─ ctx.remote.pluginManager.removeBundle()      → 卸载
  ├─ ctx.remote.pluginManager.installBundle()     → 安装指定版本（enabled / saveExact / requestId）
  ├─ ctx.remote.pluginManager.setBundleEnabled()  → 恢复启用状态（取消重启时）
  ├─ ctx.remote.$on('plugin-manager/install-log') → 实时 pnpm 日志
  ├─ fetch https://registry.npmjs.org/<pkg>/latest→ 第三方包“最新版”（浏览器直连，带超时/多镜像回退）
  └─ fetch /plugin-updates/*                       → 宿主端（队列、重启、开机续做）

宿主端（index.js，挂在 DSH 的 webServer 上，前缀 /plugin-updates）
  ├─ GET  /state     队列快照 + lastRun + 本次进程的 nonce（?probe 已移除）
  ├─ GET  /policy    profile 里 pnpm-workspace.yaml 的 minimumReleaseAge
  ├─ GET  /bundles   诊断：listBundles 的 name/source/version/enabled
  ├─ POST /check     查注册表最新版本（带 10 分钟缓存与 4 路并发）
  ├─ POST /prepare   把“运行中换不掉”的插件写进队列，并先 setBundleEnabled(false)
  ├─ POST /restart   退出当前进程（可选：执行 restart.json 里的自定义命令），由外层拉起
  ├─ POST /cancel    取消队列并把 enabled 恢复回去
  ├─ POST /policy    改 minimumReleaseAge（写前留 .bak；无文件则 409 不动手）
  └─ POST /ack       清掉 lastRun 提示

开机续做不走 HTTP：进程启动后由宿主自己在 app-boot 钩子里跑 resume()，见下。
```

**两条升级路径**

1. **热路径**（绝大多数第三方包）：`inspect('name@目标版本')` 预检 → `removeBundle` → `installBundle('name@目标版本', {enabled: 原状态, saveExact:true})`。预检被拒（版本不存在、不是包、不是 bundle、注册表不可达）时**原地取消，不动已装版本**；安装失败自动回滚到旧版本；回滚也失败时给出 `dsh plugin add <name>@<旧版本>` 恢复命令。
2. **冷路径**（`bundle-in-use` / `stop-profile`，即包正在运行、进程内卸不掉）：按钮变「重启并升级」→ 弹窗确认 → `/prepare`（先禁用，保证下次启动不加载）→ `/restart`（进程退出，由启动它的外壳重新拉起）→ 进程起来后宿主端在 `app-boot/config-reload` 钩子里 `/resume`：此时包没被加载，`removeBundle` 能成功 → 装新版本 → 按原 `enabled` 状态恢复。结果写进 `lastRun`，页面刷新后显示“上次重启升级结果”。

**为什么先禁用再重启**：`removeBundle` 内部的顺序是「先 `selectBundle(false)` 并落盘，再检查 fiber 是否还活着」。运行中的包检查必然失败，但它**已经把 enabled=false 写进 profile** 了——所以失败后必须能取消/恢复，否则插件会“升级没成，先被禁用”。`/cancel`、`/repair` 就是干这个的。

## 三、开发计划（实际执行）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 调研 | `pluginManager` 服务语义、`plugins.tab` 槽位契约、`ctx.remote` 用法、`removeBundle` 的副作用、容器重启可行性 | ✅ |
| 2 方案 | 内置页标签页 + 复用 pluginManager + 热/冷两条路径 + 队列落盘续做 | ✅ |
| 3 实现 | `client.js`（检测/单升/全升/回滚/重启弹窗/图标中文名/单行简介/日志/i18n）+ `index.js`（队列/重启/续做） | ✅ |
| 4 安装 | `link:` 装进 web profile，模块图出现条目，`/plugin-updates/state` 200 | ✅ |
| 5 验证 | 宿主端 7 个路由的桩测试全过；客户端组件桩渲染 22 项断言全过；真实容器识别唯一命中 | ✅ |
| 6 交付 | 本 README + 使用/回滚/注意项 | ✅ |

## 四、使用

1. **刷新页面（F5）**：新增的客户端模块要在页面加载时拉取。
2. 左侧「插件」→ 顶部 **更新** 标签页。
3. 点「检测更新」：逐包对比「已装版本 vs 最新版本」，状态为 `可升级 / 已最新 / 无法检测 / 镜像提供 / 本地插件 / 已停用`。
4. 单行「升级」；或「全部升级」（先弹确认框，列出要升的包）。
5. 若某包报「正在被使用」：该行按钮会变成 **重启并升级**，点击 → 确认 → 自动重启 DSH → 页面自动刷新 → 结果在顶部横幅里。
6. 全部升级里遇到需要重启的包：批量跑完后统一弹窗，一次性重启、一次性续做。
7. 「升级日志」可展开 pnpm 实时输出；失败行会给出原因（含 `minimumReleaseAge` 的友好提示）。

## 五、开发注意项（改这个插件前先读）

1. **升级必须 remove → install**。HMR 活着的 profile 里，`installBundle` 对已存在的包名会抛 `already-installed`。
2. **`removeBundle` 失败会留下“已禁用”的副作用**（它先落盘禁用再检查 fiber）。任何失败路径都要 `setBundleEnabled(原状态)` 或走 `/cancel`。
3. **必须能回滚**。`installBundle` 失败时宿主会还原 `package.json` / `pnpm-lock.yaml`，但**已卸载的包不会自己回来**——本插件会装回旧版本，再失败才提示手动命令。
4. **不要碰 profile 的 `package.json` / `cordis.patch.yml` / `cordis.yml`**，也不要 `cd` 进 profile 跑 pnpm；只用 `pluginManager` 服务。
5. **宿主端不写 typert 远程服务**：手写 `typert.host.js` 易被版本校验拒绝；本插件的宿主端只注册一条普通 HTTP 路由（`ctx.webServer.register`）。
6. **重启不依赖任何平台工具**（不调用 docker，也不假设容器）：`/restart` 先把响应 flush 出去，然后 `process.exit(0)`，由启动 DSH 的外层把它拉回来——Docker 的 `restart: unless-stopped`、systemd 的 `Restart=`、桌面端/守护进程都一样，同一套代码在所有端一致。需要自定义时，可在 profile 下 `.plugin-updates/restart.json` 写 `{"command":"..."}` 或用环境变量 `DSH_RESTART_COMMAND`，宿主会先执行它再退出。这套重启由本插件自己实现（`index.js` 里的 `restart()` / `performRestart()`），不依赖、不调用任何其他插件，也不依赖 docker。
7. **重启会中断当前页面，并且必须有外层守护**：`/restart` 只是 `process.exit(0)`，把进程拉回来的是启动它的那个东西（Docker 的 `restart: unless-stopped`、systemd 的 `Restart=`、桌面端）。**在终端里手工 `dsh --profile web` 起的实例，退出后不会自己回来**——界面的重启确认框已经写明这一点。进程退出到重新可用通常 10–30 秒；页面轮询 `/state`（`restart()` 的 busy 标志 20 秒后自动解除，不会永久 409）探测到新 nonce 后自动 `location.reload()`。
8. **官方包不可卸载**：`removable:false` 的是镜像自带（`shipped`），显示「镜像提供」并禁用。
9. **官方包版本会一直显示可升级**：`installTarget.version` 跟运行时版本（`0.2.1-rc.5`），镜像里实际是 `0.2.1-rc.4`。这是预期行为。
10. **第三方包最新版靠浏览器直连 registry**；没外网/CORS 被挡时显示「无法检测」，不影响其它功能。npm 对 `/<pkg>` 和 `/<pkg>/latest` 都返回 `Access-Control-Allow-Origin: *`。
11. **`minimumReleaseAge` 是仓库策略**：刚发布（<24h）的版本会被 pnpm 拒绝，页面会提示“稍后再试”，不要绕过。
12. **`plugin-manager/changed` 事件在升级过程中会触发**：用 `mutating` 屏蔽，避免把“卸载中”的包当成“已消失”。
13. **宿主端改动要重启 DSH 才生效**；`client.js` 改动 HMR 会重建模块图（rev 变化），但**新增/删除模块条目**要整页重载。
14. **`crypto.randomUUID` 在非 HTTPS/非 localhost 下不存在**，代码里已 fallback。
15. **本插件排除自己**（`dsh-plugin-updates`）：升级自己会让页面在卸载瞬间失去 UI。
16. **并发**：检测 3 路并发 + 8s 超时；升级串行（宿主 install 锁只允许一个操作）。

## 六、故障处理

- **升级报 `already-installed`**：多半不是真的重复安装，而是 pnpm 在 `remove` 阶段就被拦了，下一步 `install` 才报这个码。看升级记录里的详细文案，通常是下一条。
- **报 `minimumReleaseAge`（发布不足 24 小时）**：pnpm 11 默认隔离 24 小时内发布的版本，并且每次安装都会重新校验整个 lockfile；只要 lockfile 里有一个这种版本，**之后所有安装/卸载都会失败**。处理：更新页点「放宽隔离期」（写 `minimumReleaseAge: 60` 到 profile 的 `pnpm-workspace.yaml`），或手工改这一行、或等它满 24 小时。
- 升级失败已自动回滚仍异常：按页面提示执行 `dsh plugin add <包名>@<旧版本>`（别进 profile 跑 pnpm）。
- 插件被“升级失败”弄成禁用：更新页顶部会提示队列/失败；点「取消并恢复」，或 `dsh plugin` 里重新启用。
- 重启后升级没续做：看 `/data/dsh/profiles/web/.plugin-updates/state.json` 是否还有 `pending`；页面横幅点「已手动重启，继续升级」。
- 标签页消失：F5；仍无则看日志里 `clientModules` 是否加载了 `dsh-plugin-updates/client.js`。
- 想彻底卸载：插件页里卸载 `dsh-plugin-updates`，或 `dsh plugin remove dsh-plugin-updates`。

## 七、文件

| 路径 | 作用 |
| --- | --- |
| `src/host/index.ts` | 宿主端源码：`/plugin-updates` 路由、队列落盘、重启、开机续做 |
| `src/client/index.ts` | 客户端源码：全部 UI 与升级逻辑（检测、单升、全升、回滚、重启弹窗、日志、中英词典） |
| `build.mjs` | esbuild 打包脚本，产出 `dist/index.js`（node/esm）与 `dist/client.js`（browser/esm） |
| `tsconfig.json` | TypeScript 配置（`npm run typecheck` 用，`noEmit`） |
| `locale/` | `zh.json` / `en.json`：插件中文名与简介（DSH 读取） |
| `icon.svg` | 插件图标（DSH 读取） |
| `dist/` | **构建产物，不要手改**；`exports` 指向这里 |
| `package.json` | 包声明：`dsh.bundle.patch` + `dsh.client` + 构建脚本 |
| `cordis.patch.yml` | 往 profile 插入本包（`id: dsh-plugin-updates`） |
| `test/upgrade-state.cjs` | 用真实 `dist/client.js` 跑行状态机的迷你 React 桩测试 |
| `CHANGELOG.md` | 版本改动 |
| `LICENSE` | MIT |
| `README.md` | 本文档 |

## 七之二、插件自身的名称、图标、简介

DSH 从包内读取展示信息，不需要改 DSH：

| 文件 | 内容 |
| --- | --- |
| `locale/zh.json` | `{ "meta": { "title": "插件升级", "description": "…" } }` |
| `locale/en.json` | 同上，英文 |
| `icon.svg` | 官方同款图标（两个渐变小方块），`package.json` 里用 `"icon": "./icon.svg"` 声明 |

- `exports` 必须导出 `./icon` 与 `./locale/*.json`，否则 DSH 解析不到。
- 中文名来自 `locale/zh.json`，DSH 的插件页与本文的「更新」页都会优先显示它。
- 没有 meta 的第三方包只能显示包名（`meta.description` 缺失时退回 `bundle.description`）；旧版遗留的 `@local/` 前缀会被去掉再显示。

## 八、除隔离期外，还有哪些限制会让升级失败

| 限制 | 典型报错 / 现象 | 本插件的处理 |
| --- | --- | --- |
| `minimumReleaseAge` 隔离期 | `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`；**lockfile 里只要有一个**这类版本，之后所有安装都会被拦 | 行内标「跳过（隔离期）」；「隔离期」按钮让用户自己调 |
| `allowBuilds` 构建脚本 | 装成功但依赖的 `postinstall` 没跑（native 模块不可用）；宿主返回 `pendingBuilds` | 目前只透出提示，需要批准构建（`installBundle` 的 `approvedBuilds`） |
| `engines.dsh` / `engines.node` | `incompatible-version` + `unmetRequirements` | 弹窗显示原因；换兼容版本或升 DSH |
| `peerDependencies` 指向 `@deepseek-ai/dsh*` | 同上 | 同上 |
| `bundle-in-use` | 「该插件正在被使用」——进程内卸不掉 | 走冷路径：按钮变「重启」→ 确认 → 重启后自动续做 |
| `not-removable` | DSH 内置的官方包 | 行内标「内置」，禁用按钮 |
| `already-installed` | HMR 在线时同名包已存在 | 本插件先 `removeBundle` 再装，已规避 |
| `allowBuilds` 未批准 | 首次安装失败并返回 `pendingBuilds` | 弹窗「批准并安装 / 跳过」；跳过会回滚旧版本，不算失败 |
| `stop-profile` | 没有 HMR 时卸运行中的包 | 需要停 profile |
| 网络 / registry / 包被撤 | `pnpm view` 超时、404、401 | 失败信息里给出 pnpm 的 `ERR_` 行 |
| 磁盘 / 权限 | `ENOSPC`、`EACCES` | 同上 |
| 并发 | profile 安装锁同一时刻只允许一个操作 | 全部升级是串行的 |

## 九、开发与构建

```bash
npm install --include=dev   # 本机 npm 默认 omit=dev，必须显式带上
npm run check               # typecheck + build + test（提交前跑这个）
npm run typecheck           # tsc -p tsconfig.json（noEmit）
npm run build               # esbuild → dist/index.js + dist/client.js
npm test                    # node test/upgrade-state.cjs
```

**版本号只写一处**：`package.json` 的 `version` 由 `build.mjs` 通过 esbuild 的
`define: { __PU_VERSION__: ... }` 注入两个产物（`src/host/index.ts` 的 `VERSION`、
`src/client/index.ts` 的 `CLIENT_VERSION`），`/state` 和工具栏显示的都是注入值。
改版本只改 `package.json`，别在源码里硬编码；忘了构建时源码里的回退值是 `0.0.0-dev`。

- 源码只写 `src/`，`dist/` 是产物；改完必须 `npm run build`，否则运行的是旧产物。
- 客户端 `require('react')` 必须保持运行时调用（由 DSH 模块加载器注入），不要把它打进包里。
- 宿主端改动要重启 DSH 进程才生效；客户端改动由 HMR 热更新，刷新页面即可。

## 十、状态显示的两个坑（v0.7.1 修复）

1. **升级完切走再回来，行里还显示旧版本 + 「可升级」**
   根因：`installed` 优先取了上次检测缓存里的 `check.installed`，而不是宿主实时的 `bundle.version`；而升级成功后只改了内存、没写回缓存，标签页切走会卸载组件、切回来又从 localStorage 播种，旧状态就复活了。
   修复：实时 `bundle.version` 优先；升级成功写穿缓存；缓存里的版本与实时版本不一致时**丢弃该条 check**（宁可显示「未检测」，也不显示假的可升级）。

2. **某行正在升级时，其它行被标成「本地开发」**
   代码里只有 `isLocalPackage()` 一条路径产生该文案（`source` 前缀 `link:/file:/workspace:`）。v0.7.1 起：状态徽标 tooltip 显示该行原始 `source`，工具栏多了「诊断」按钮（复制每行 `{name, source, version, status, official, removable}`），工具栏右侧显示客户端版本号。再出现时用这三样就能直接定位是宿主给的 `source` 有问题，还是页面跑着旧 bundle。

## 十一、卡在「正在升级中」

`removeBundle` / `installBundle` 的 RPC 在页面切走、SSE 重连后可能永远不返回，`busy` 就一直不清。v0.7.1 起：remove 5 分钟、install 10 分钟强制结束等待；**超时不回滚**（避免两个 pnpm 抢同一个 profile），只提示「后台可能仍在安装，稍后刷新核对」。切回标签页（`visibilitychange`）会重新拉取宿主状态。

## 十二、环境前提

- **DSH ≥ 0.2.1-rc.5**：用到 `pluginManager` 的 `inspect` / `installBundle` / `removeBundle` /
  `setBundleEnabled` / `waitForInstall`，以及插件页的 `plugins.tab` 槽位。
- **Node ≥ 20**：宿主端用全局 `fetch` 与 `AbortSignal.timeout`（`package.json` 的 `engines` 已声明）。
- **平台**：`dsh.client.platform = web`。同一份客户端代码在任何加载客户端模块的壳里都能跑。
- **检测需要浏览器能直连 registry**（默认 npmjs + 镜像回退）。内网部署时「无法检测」是预期结果，
  升级本身仍可用（升级走宿主端的 pnpm，不经过浏览器）。

## 十三、安装

```bash
# 从 GitHub（仓库内含 dist/，不需要构建）
dsh plugin add https://github.com/SquirrelJimmy/dsh-plugin-updates.git

# 或从本地目录（link: 方式，改文件即热更，适合开发）
dsh plugin add /path/to/dsh-plugin-update
```

安装后**重启 DSH**（宿主端代码要重启才加载），再刷新页面，插件页顶部会出现「更新」标签页。

从源码构建过一次再装也可以：

```bash
npm install --include=dev && npm run check
```

## 十四、已知限制

- 检测依赖浏览器直连 registry，没有外网/CORS 被挡时只显示「无法检测」。
- `minimumReleaseAge` 是 profile 的策略，本插件只做提示与「让用户自己调」，**不绕过**。
- 官方内置包（`removable: false`）随镜像发布，只能重建镜像来更新。
- 「重启」只负责退出进程，把进程拉回来的是外层守护（见「五、开发注意项」第 7 条）。
- 官方包的「可升级」会一直显示：`installTarget.version` 跟运行时版本，镜像里通常落后一个 rc。
- 同一个 profile 的状态（队列、lastRun）是共享的；多开浏览器时看到的是同一份队列。

## 十五、发布到 npm（后续）

代码先上 GitHub，npm 发布另说。真要发时：

```bash
npm run check     # typecheck + build + test，全绿再发
npm publish       # prepublishOnly 会再跑一次 check
```

- 版本只改 `package.json` 的 `version`（注入机制见「九、开发与构建」）。
- `files` 已包含 `dist/`、`locale/`、`icon.svg`、`LICENSE`、`CHANGELOG.md`、`README.md`。
- 发布后用户可 `dsh plugin add dsh-plugin-updates@<version>`。

# AGENTS.md

> 本仓库的 agent 事实清单：只写验证过的、仓库特有的内容，发现新事实就地更新。

## Project

- DSH（DeepSeek Harness）插件 `dsh-change-review`：追踪会话内 `write`/`edit` 工具调用，按会话展示 diff 审查、轮次与撤回。
- 两半：Host 端 `lib/index.js`（记录改动 + 注册 HTTP 路由），浏览器端 `lib/client.js`（`window.__ModuleLoader__.load` 的 bundle）。
- **无构建步骤**：`package.json` 的 `dsh.client`/`exports["./client"]` 直接指向仓库里的 `lib/client.js`，改完刷新页面即可；`cordis.patch.yml` 向 bundle 插入 `id: diff-review`。

## Commands

- 语法检查：`node --check lib/index.js`、`node --check lib/client.js`
- 本机 node：`D:\scoop\apps\nvm\current\nodejs\nodejs\node.exe`（注意 `nodejs\nodejs` 双层目录；`node` 已在 PATH）
- 无测试框架、无 npm script。验证方式：离线 `import` `lib/index.js`（`export { apply }`）+ 假 ctx（`on`/`effect`/`webServer.register`/`agents.store`），触发 `tools/result` 后直接调用 `/diff-review/summary|turn` 的 handler 断言载荷。

## Architecture

- 记录：`ctx.on('tools/result')`，只看 `write`/`edit` 的成功结果；子代理沿 owner 链聚合到根会话（`resolveRootId`）。
- 状态：`$DSH_HOME/diff-review/<sessionId>.json`，UI 偏好 `$DSH_HOME/diff-review/ui/<sessionId>.json`；`DSH_HOME` 未设置/空白时回退 `~/.dsh`。两者不同根时启动会一次性搬迁旧 `~/.dsh/diff-review`（幂等、不覆盖新根）。
- HTTP：`/diff-review/events`(SSE) `summary` `file` `turn` `against` `revert` `clear` `ui-prefs` `editors` `open-with-editor` `open` `reveal`；UI 走 `inject: ['webServer', 'agents']`。
- 「打开文件」两级：**优先在 DSH 右侧 Sidebar 内预览** —— `ctx.get("sidebarRight").openResource(address)`，地址为 `dsh-resource://file/session/<sessionId>/<path>`（构造逻辑内联自 `@deepseek-ai/dsh-util-workspace-path` 的 `fileAddressFor`：会话工作区内的绝对路径转相对、工作区外保留绝对、盘符冒号不编码；`ui-chat` 与 `dsh-better-sidebar` 都是这样调的）；服务缺失或地址被拒时**降级**为宿主 `POST /diff-review/open`（{path}）→ `spawn` 系统打开器（win32 `cmd /c start ""` + `windowsVerbatimArguments`、darwin `open`、其它 `xdg-open`）。
- **侧栏「审查 diff」tab（本插件自注册）**：类型 `id: dsh-change-review:diff-review` / `kind: diff-review` / `patterns: ["dsh-resource://diff-review/**"]` / `priority: extension`；地址 `dsh-resource://diff-review/session/<sid>/<整段编码的原始路径>`（**路径整体作为一段 encodeURIComponent，反斜杠→%5C，逐字还原**——宿主 `files.get(path)` 是精确匹配）；正文注册到 `sidebar.right.pane.tab`，**`key` 必须是类型 `id`**，组件从框架注入的 prop `useTabInfo()` 读 `tab.contentId`（= 整条地址，也是去重键）、`tab.visible`、`tab.signal`。正文 `DiffPane` 走本插件 HTTP 路由取数（本协议没有 `ctx.resources` provider，`useResource` 恒为 none）。**刷新语义**：ops（会话记录）模式自动刷新——宿主每次记录改动都 SSE 广播 → 客户端 `refreshFromServer()` 里 `reviewTick+1` → 面板重拉 `/diff-review/file`，另有 15s 兜底轮询；`initial`/`git` 两种对比刻意**不**自动刷新（避免每次改动都跑一次 `git show`），靠面板第二行的「刷新」按钮手动重取；自动刷新一律以 `tab.visible` 为闸门（收起侧栏/后台 tab 不空转，重新可见时立刻刷一次）。**审查列表入口分工（2026-09-14 定稿）：点文件名/点整行 = 打开 diff tab（默认动作）；行尾「打开文件」按钮 = 在侧栏打开文件本身**（该按钮 `stopPropagation`，避免同时触发整行动作）；删除态只置灰「打开文件」。
- 面板宽度：审查列表与官方「任务」面板同在 `conversation.input.dock` 插槽，宽度照抄官方 `TodoPanel` 根节点公式（桌面端 `--dsh-composer-side-clearance=16px`、`--dsh-composer-dock-inset=8px`），改宽度时两者要同步考虑。
- 轮次：写记录时 `currentTurnOf(rootId)` 给 `op.turn` 打标（扫描最后一个未结束的 `turn/start`）；修复前落盘的旧记录（`turn=0`）由 `opTurn` 按 `turn/start` 事件的 `time` 时间戳反推回填。
- 文件状态：`summary` / `turn` / `file` 三个载荷的文件项都带 `status`（`added` | `modified` | `deleted`），宿主 `statusOf(rec)` 判定 —— 新增 = 首个 op 的 `before === null`；删除 = **绝对路径当前在磁盘上不存在**（`existsSync`，实时判定，不解析删除命令）；相对路径且记录无 `cwd` 时不判删除（避免误报）。UI 用 `.dsdrv-status` 胶囊显示，颜色复用 turnAdd/turnDel/latestName，删除态文件名加删除线且禁用「打开」。

## Conventions

- 每个文件头必须有 `@description`/`@author`/`@date`，每次改动在文件头追加 `@modify <日期> <说明>`。
- 函数与复杂逻辑写中文注释；单行 `if` 也必须带大括号；不留空代码块。

## Pitfalls

- **`Session` 没有 `events` 属性**：`@deepseek-ai/dsh-session` 只暴露 `snapshotEvents()` / `ownEvents()`。旧写法 `session.events` 静默得到 `undefined`（被 `Array.isArray` 挡掉），导致 `op.turn` 恒为 0、审查列表不显示轮次、每轮问题为空（2026-09-14 修复为 `sessionOf()` + `eventsOf()` 适配；旧记录靠时间线回填）。
- **别猜客户端 service 方法**：`ctx.workspaces.openPath` 在桌面端不存在（全量客户端包 grep 0 命中），旧代码调用后静默 no-op、点击毫无反应。要打开文件用官方 `ctx.get("sidebarRight").openResource()`（第三方 `dsh-better-sidebar` 也是这么调的；未声明的服务要走 `ctx.get`，属性直读受 `inject` 约束取不到）。
- **`dsh-resource` 地址必须是 session 作用域**：文档预览 tab 注册的 pattern 是 `dsh-resource://file/**`，但 `hostFileOf()` 只接受 `file/session/<sessionId>/<path>`；`absolute` 作用域它会 throw（"not a session file address"），地址无人认领时 `openResource` 同样 throw。宿主侧 `workspaceFiles.read` 允许绝对路径与工作区外的文件。
- **注册 sidebarRightTabs 必须等它到齐**：用 `ctx.inject(["sidebarRightTabs"], cb)`（服务出现/重现时会重跑），**别在 apply 里 `ctx.get` 一把**——席位声明可能早于该服务出现，一次性读会永久注册不上（better-sidebar 在其源码注释里记录了实测踩坑）。也不要把 `sidebarRightTabs` 写进插件级 `inject`：服务缺失会让整个插件挂起。另：`ctx.get` 免声明且不报错，**属性直读 `ctx.sidebarRightTabs` 未声明 inject 会直接 throw**。
- **删除只能靠磁盘判定**：插件只监听 `write`/`edit`，删文件通常走 shell 命令（`Remove-Item`/`rm`），解析命令不可靠；`statusOf()` 因此以「文件当前是否存在」为准。推论：会话外被删的文件也会显示「删除」（这正是期望），而**新建后又删掉**的文件显示「删除」而不是「新增」。
- **Windows 路径**：Host 端文件项的 `name` 是 `String(path).split('/').pop()`，反斜杠路径下等于整条路径；要展示路径请用 `repoPath`（仓库相对）/ `absPath`（绝对）。
- **生效范围**：Host 端改动需**重启 DSH Desktop**；客户端 bundle 改动刷新页面即可。桌面壳每次启动都会按 `dsh.profile.bundles` 重写顺序。

## Maintenance

- 桌面 profile：`C:\Users\czy\.dsh\profiles\desktop`；当前激活 profile 见 `%APPDATA%\DSH Desktop\profile-selection\state.json`（`active: desktop`）。
- 校验「安装件 = 仓库」：`profiles/desktop/package.json` 依赖为 `link:D:/work/github/dsh-change-review`，且 `node_modules/dsh-change-review` 是 `SymbolicLink` 指向本仓库 —— 改仓库文件即改安装件，无需重装。

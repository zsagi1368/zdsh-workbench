# Changelog

All notable changes to zdsh-workbench are documented here. Format follows Keep a Changelog; versions are semver with pre-release tags.

## [Unreleased]

O3 装件化·阶段 1 真源现代化（用户 O-3 裁决，2026-09-27）：

### Added

- package.json `dsh` 段补齐治理声明面：`compatible`/`capabilities[].service`（factory=./lib/index.js）/`sandbox`（诚实申报：spawn=true+allowedCommands 六命令+env 面文档申报）/`client`（platform web + inject []，运行时零 @deepseek-ai 值依赖实测）。
- client 构建面改 ModuleLoader factory 形（tsdown cjs+banner/footer，PluginCenter 同款 vendor 化先例）；lib/index.js + lib/client.js prebuilt 入库（FileHub TC-B3-31C 先例，git+pin 快照离线首启）。
- RA1d 判据 domain teardown 接线（ptyRegistry.disposeAll + watchers.closeAll + task 订阅释放，ctx.effect 双箭头形）。
- tests：build-artifact.client.spec（factory 形四腿锁）+ manifest spec dsh 段/双轨交叉锁扩展 + teardown.host.spec（disposeAll 单元腿+apply 接线集成腿）。

### Changed

- README.zh.md 头注权威源声明补齐（双语对称，T3b-B 遗留）。
- README.md/README.zh.md 安全模型节补进程面/环境变量面诚实申报（sandbox spawn 声明的文档面）。
- .gitignore：lib/ 轮转为 FileHub 形否定式（!lib/index.js、!lib/client.js）。
- docs/PLAN.md §12 追加 D6 双轨关系注记（运行时消费面=package.json dsh 段；dsh.plugin.json=独立生态身份面，保留零修改）。

T3a 双源收敛（D3 裁决，2026-09-27）：主仓 in-tree `packages/client/workbench`
（基线 `30e4d503f4`）全部领先行回灌本仓，本仓恢复为唯一活跃真源。

### Added

- **Compat guard**（`src/compat.ts` + vendored `src/vendor/dsh-compat/`）：注册前探测宿主核心符号，API 漂移时自动降级跳过注册而非崩溃；`apply` 相应改为 async。dsh-compat 未发布 npm（404），故按 index 入口面（probe+guard，零外部依赖）逐字内置，出处与刷新规则见 `src/vendor/dsh-compat/VENDOR.md`。
- **i18n**：`src/client/locales.ts` 中英键对称字典 + `src/client/shell/context.ts` 翻译上下文；client 入口经 `ctx.locale` 注册命名空间（宿主提供 LocaleRuntime）。
- **系统探针**：`src/system-probe.ts`（`where.exe`/`which` 查找绝对路径化、fail-closed），git-runner 与 pty-registry 全面接入——绝不以裸名 spawn（FB1 系加固）。
- 新测试：`git-runner.host.spec`、`pty-registry.resolve.host.spec`、`system-probe.host.spec`；既有测试重命名为 in-tree `.host.spec`/`.client.spec` 约定；manifest spec 融合 package exports 断言。
- devDependencies 新增 `@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-slots`（均 `=0.1.5-rc.2`，type-only）与 `@testing-library/react ^16.1.0`；`@xterm/xterm` 移入 devDependencies（client bundle 已内联，无运行时依赖）。

### Changed

- 宿主 pin 轮转：`@deepseek-ai/dsh-host-webserver` `=0.1.2-rc.1` → `=0.1.5-rc.2`（devDependencies；pnpm-workspace.yaml `minimumReleaseAgeExclude` 同步轮转）。
- `node-pty` `^1.1.0` → `1.2.0-beta.15`（对齐 in-tree 受测依赖矩阵）。
- 面板/壳层功能面同步 in-tree 演进（文件树符号链接语义、任务台账派生链、终端重连回放、git 网络操作预览确认等既有能力的加固与扩展）。
- `README-ARCHIVED.md` 顶部追加 SUPERSEDED 通告（原文保留为历史记录）。
- 身份常量不变：包名 `zdsh-workbench`、插件 id `zdsh/workbench`、版本 `0.1.0-beta.1`（`src/shared/protocol.ts` 按真源侧保留，manifest 三方校验守护同步）。

## [0.1.0-beta.1] — 2026-08-24

First public beta: the full M1–M7 milestone scope of the founding plan (docs/PLAN.md).

### Added

- **Shell** (`M1`): right-edge dock with tab rail, `+` menu, drag-resize width, collapse toggle; per-scope layout persistence with orphan-tab recovery; command palette (Ctrl/Cmd+Shift+P) with fuzzy filtering and keyboard navigation; shell settings panel (start-collapsed, palette hotkey) with strict preference validation.
- **Registry service**: `ctx.workbench` client cordis service exposing `registerPanel` / `registerCommand`, reference-stable snapshots, `version` + monotonic `features` capability vocabulary. Built-in features register through the same public api as third-party code.
- **Host routes**: `/workbench/api/<method>` JSON envelope router; `/workbench/events` SSE channel (heartbeats, fs batches + task revision signals); `/workbench/file` media byte route; `/workbench/ws/terminal` PTY WebSocket. Every route passes the browser-trust fence mirroring the host's own `/api` posture.
- **Files workbench** (`M2`): lazy directory tree with symlink-target semantics and broken-link flags, breadcrumb navigation, name search skipping vendored/hidden trees, atomic tmp+rename writes, UTF-8-safe truncated text reads, binary detection (extension + NUL sniff), upload via editor save path, sandboxed iframe HTML preview, MVP text editor with Ctrl/Cmd+S save.
- **Terminal** (`M3`): real PTY terminals (node-pty + xterm.js) with per-session quota (3), reconnect scrollback replay via ring buffer, grace-period process lingering after socket drop, Windows shell probe (pwsh → powershell → ComSpec) validated against a strict allowlist shape, repair banner for package-manager build approval gates.
- **Git center** (`M4`): status with branch pill and ahead/behind, change list, inline colored diff, stage/unstage, Ctrl/Cmd+Enter commit, history list, fetch/pull/push behind preview-confirm dialogs; argv-array execution only, no shell, no identity writes.
- **Task center** (`M5`): host-authoritative kanban ledger (todo/doing/done) with monotonic revision, atomic persistence, corrupt-document quarantine, SSE pull-on-signal refresh.
- **Browse** (`M6`): multi-tab sandboxed browser over opaque-origin iframes, pure URL guard refusing scripting schemes and internal-network hosts, one-click system-browser handoff.
- **Polish** (`M7`): media byte previews for images and PDFs with download fallback; multi-terminal inner tabs; mobile full-width drawer under 768px.

### Security

- Workspace path guard on every filesystem/git operation: absolute-path requirement, containment including the win32 cross-drive `relative()` trap, symlink realpath escapes refused, checks re-run at call time.
- Trust fence on every HTTP/WS/SSE route sharing the host's trust source semantics.
- Browser/HTML content rendered in opaque-origin sandboxes by default; address bar refuses `javascript:` / `data:` / `file:` and loopback/private targets.

### Known limitations

- Side chat (session fork) ships in the integration phase once verified against a live runtime; the native fork API is confirmed available (research doc R08).
- CodeMirror upgrade for the editor and rendered Markdown view land post-beta; the MVP textarea editor is fully functional.
- Session-scoped terminal ownership uses the page session id constant until runtime wiring lands in the integration phase.

# P01 · zDSH 工作台（Workbench）— 全新核心插件完整规划

> 状态：**v3 已批准（2026-08-24）**。交付顺序二次变更（用户指令）：**先独立插件，后分支集成**——v1 全程以独立插件形态开发并发布 GitHub（`zsagi1368/zdsh-workbench`）；分支集成挂起，待分支主开发结束且收到用户明确指令后再按 §4 内核化适配。M0 三项 spike 全部通过（docs/R08）。
>
> **v3 变更记录**：
> 1. 开发主目录改为独立仓库 `G:\000Github\DSH\Workbench`；Fork-WB worktree 保留作真实挂载 e2e 载具与未来集成工作区。
> 2. v1 物理形态定为**单 npm 包**（仓库内 host/client 目录模块化 + 懒 chunk，better-sidebar 已验证的分发形态）；多包物理拆分推迟到集成阶段与首方化一起决策。§5 的多包结构降级为"集成阶段参考"，模块边界要求不变（注册表 API 隔离 + 设置逐面板开关 + 懒 chunk 即"可拆分"的 v1 落实形式）。
> 3. §8 上游免疫条款对 v1 简化为：零改动上游文件（独立包不触碰分支）；契约测试三道闸保留（面向宿主 SDK 版本漂移）。
> 4. Spike 净影响：无新增运行时依赖；D3 可行性上调（原生 fork API），仍不进 v1。
> 日期：2026-08-24。研究依据：docs/R04（Fork 扩展点）、R05/R06（dsh-web-ui 全家桶）、R07（DSH-better-sidebar）。
> 红线声明：**净室开发**——只吸收两个社区仓库的功能思想与机制设计，不复制任何代码、API 形状或资源；符合项目"社区代码禁令"（宪章 2026-08-22）。

---

## 1. 背景与目标

用户指令：深入研究 `zhu1090093659/dsh-web-ui`（Web 插件全家桶，18 包）与 `omdsh-dev/DSH-better-sidebar`（VSCode 式侧边栏工作台，28+ 生态插件的服务化基座），在此基础上**全新开发、全新结构**地做一个"集众家之长且更好"的整合插件：

1. **内核核心插件形态**：作为 zDSH 分支的一等公民功能直接内置，部署即开箱即用；
2. **可拆分形态**：每个功能面板都是独立包，可单独启停，未来亦可拆出为独立插件；
3. **上游免疫**：官方后续升级不影响分支的独立功能——接线面最小化 + 契约测试守护。

## 2. 两仓库研究结论摘要（详见 R05/R06/R07）

| 维度 | dsh-web-ui 全家桶 | dsh-better-sidebar | zDSH Workbench 取舍 |
|---|---|---|---|
| 架构 | 20 包聚合单体仓（aggregate.yml 代码生成 + id 命名空间防双挂载） | 单 npm 包巨石（host/client 双半） | **内核外壳 + N 个薄功能包**：聚合的分包清晰度 + 单包的安装简单性 |
| 扩展点 | settings 一级分区 + `web-ui.plugin.item` 子槽位 | `ctx.betterSidebar`：registerTab / registerFileViewer 两个扩展点，内置吃狗粮 | 自有注册表 **7 类扩展点**（§6.1），内置全部吃狗粮 |
| 状态模型 | task-board：Host 权威账本 + revision 快照 + SSE 只发信号 | client localStorage 按会话持久化 | **Host 权威账本 + SSE 信号 + client 缓存**，跨标签页 Web Locks 选主单连接 |
| 设置 | schemastery → `$DSH_HOME/settings.yaml`（官方通道） | 声明式三层设置行（toggles/pluginToggles/render）+ 侧边卡片开关 | **schema 驱动统一设置框架**：官方 settings section 收纳 + 卡片逐项开关 + 插件自有键 |
| 安全 | remote-web-ui 安全设计最重；skill-explorer realpath 门禁 | 沙箱 iframe（不透明源默认）+ workspace 路径门禁 + head 嗅探 | realpath 门禁 + 写前重校验 + 原子写 + SSRF guard（http/https only，拒环回/私有/保留地址）+ opaque 沙箱默认 |
| 终端 | dsh-ssh 池化 PTY/SFTP/隧道 | node-pty + xterm + 断线回放 + tmux 语义 agent 工具×8 | node-pty + xterm + agent 工具 + **拖拽跨栏不重挂载**（portal 重挂父） |
| Git | git-graph 分支胶囊 + 图谱（host 门禁执行） | status/diff/log/stage/commit，**无 push/pull/fetch** | 补齐 fetch/pull/push（确认制）+ 分支切换胶囊 + diff tab |
| 任务 | task-board 看板 + host cron + 防睡眠 + 关浏览器结算 | 子代理拓扑 + 后台任务实时输出 | 合并为**任务中心**：看板 + 子代理 + 后台任务三合一 |
| 会话增强 | chat-recovery fork 式编辑最近消息 | sidechat 诚实冻结子线程 | 侧聊进 v1（诚实冻结语义）；fork 式历史编辑列 backlog 待用户决策 |
| 其他吸收 | skill-explorer 技能中心；session-id 复制；doctor 事务修复思想；SSE 选主 | 孤儿 Tab 占位恢复；features[] 能力探测；懒分包；协议分流浏览器；声明式推荐目录 | 全部纳入对应面板或机制 |

**质量基准**：全家桶约 2400 用例（doctor 342 / describe-image 308）；better-sidebar 约 100 spec + 真实挂载 Playwright e2e。Workbench 以同级为质量下限。

## 3. 产品定义

**名称**：zDSH 工作台（internal id：`workbench`）。一句话：*zDSH 的内置 IDE 级工作台——文件、终端、Git、任务、浏览、侧聊一屏直达，且是一切面板型插件的宿主底座。*

**北极星对齐**（宪章）：最好用（开箱即用、Windows 体验簇优先）；最省 tokens（工作台不注入任何提示词内容，纯 UI 面，KV 缓存零影响——沿官方包 README 的 KV Cache effect 声明惯例）；插件生态安全（注册者崩溃只影响自身，吞错降级）。

## 4. 总体架构

### 4.1 三层形态（内核核心插件）

```
┌─ 浏览器 ──────────────────────────────────────────────┐
│ ui-workbench（外壳）                                  │
│  · 右侧 dock + 底部面板 + 分栏/合并/移动端抽屉          │
│  · WorkbenchRegistry 客户端服务（ctx.workbench）       │
│  · 命令面板 / 快捷键 / 状态条 / 设置卡 / 会话隔离布局    │
│ ui-workbench-files / -terminal / -git / -tasks /      │
│ -browse / -sidechat / -viewers …（功能面板包，可拆分）  │
│    每个都经 ctx.workbench 注册（吃狗粮，能力对等）       │
└──────────────┬───────────────────────────────────────┘
               │ typed Remote 面（typert 协议）+ /workbench/* HTTP/WS + SSE
┌──────────────┴───────────────────────────────────────┐
│ workbench-host（Host 半）                             │
│  · ctx.webServer 注册 /workbench/api/*、/file、/ws/*   │
│  · fs/git/pty/账本单例（host-plane 归属原则，R04 §2）   │
│  · typert Remote 面 `workbench`（结构化 RPC）          │
│  · SSE 信令通道 + 信任围栏（复用 /api 同源信任列表）      │
└──────────────────────────────────────────────────────┘
```

- **依赖方向铁律**：功能包 → 只依赖外壳的 API 类型（type-only）+ 注入 `ctx.workbench`；外壳绝不 import 任何功能包。这是"拆分独立插件"的结构保证。
- **Host 平面归属**：fs 树/索引、git 执行器、pty 注册表、任务账本均为进程单例 → 全部住 Host 半（R04 §2 host-plane 原则）；preset 只能裁剪可见性不能复制单例。
- **KV 缓存零影响**：工作台一切操作不写会话事件、不注入提示词（唯一例外：侧聊创建子会话属会话系统自身语义）。

### 4.2 双形态说明（内核 ⇄ 独立插件）

- **内核形态（默认交付）**：web-app bundle patch 追加行装配，随分支发布即启用；设置页有总开关（关闭则 dock 不渲染，零残留）。
- **独立形态（预留能力，不在 v1 发布）**：每个功能包自带完整 manifest 即天然可拆；未来如需对外分发，补 `dsh.bundle.patch` + `cordis.patch.yml` 行即可走官方 `dsh plugin add` 链路——结构上零改造。
- **可移植性铁律（2026-08-24 用户拍板 D5 变更后生效）**：独立形态升级为交付目标——同一份源码既要进分支内核、也要以独立插件身份发布 GitHub（`zsagi1368/zdsh-workbench`）。因此全部 workbench 包**只允许依赖 `@deepseek-ai/*` 宿主公共面（peerDependencies，运行时由宿主供给）与自包含第三方库**，禁止 import 分支内部包路径或依赖 fork 专属构建设施；对分支共享文件的接线改动（patch 行/references 行）只存在于分支侧装配层，独立仓库用自带 bundle patch 表达同等装配。开发分支 `our/workbench`（独立 worktree），里程碑验收后合入 `our/v2`。

## 5. 目录与包结构（全新结构）

```
packages/
├─ host/workbench-host/                  # @deepseek-ai/dsh-host-workbench
│  └─ src/{index,routes,fs-service,git-service,pty-registry,
│         ledger,sse-channel,path-guard,ssrf-guard,trust}.ts
│  └─ tests/                             # vitest glob 硬约定 tests/**
├─ client/ui-workbench/                  # @deepseek-ai/dsh-client-ui-workbench（外壳）
│  └─ src/client/{index.tsx,registry,dock,panel,split,command-palette,
│         keybindings,statusbar,layout-store,prefs,mobile,locales.ts,…}
├─ client/ui-workbench-files/            # 资源管理器 + 编辑器 + 上传
├─ client/ui-workbench-viewers/          # md/img/pdf/html/code(+office 懒 chunk)
├─ client/ui-workbench-terminal/         # 终端 + agent 工具的 client 面
├─ client/ui-workbench-git/              # Git 面板 + diff + 分支胶囊
├─ client/ui-workbench-tasks/            # 任务中心：看板 + 子代理 + 后台任务
├─ client/ui-workbench-browse/           # 沙箱浏览器 tab
├─ client/ui-workbench-sidechat/         # 侧边对话
└─ client/ui-workbench-skills/           # 技能面板（v1 可选，见里程碑）
```

- 不新建 group（packages/host/*、packages/client/* 已在 paths 通配内）→ tsconfig.base.json **零改动**（R04 §6.1）。
- agent 终端工具（模型面）放 `packages/tools/workbench-terminal-tools` 或并入 host 包 exports——实现期按 tools 组惯例定，倾向独立小包以保持工具纯度（C1/C4/C6/C10）。
- 命名遵循仓库双惯例之一并在实现时对齐 check-workspace-constraints 校验。

## 6. 核心机制设计

### 6.1 客户端注册表 `ctx.workbench`（自有 API，超越两原型）

```ts
interface WorkbenchRegistry {
  // —— 面板类（对标 better-sidebar，语义重设计）——
  registerPanel(p: PanelDescriptor): Disposable      // dock/底部面板的可开页面
  registerViewer(v: ViewerDescriptor): Disposable    // 文件预览器（priority+detect 裁决）
  // —— 新增扩展点（两原型没有的）——
  registerCommand(c: CommandDescriptor): Disposable  // 命令面板条目 + 快捷键绑定
  registerStatusItem(s: StatusItemDescriptor): Disposable // 底部状态条座席（分支胶囊等）
  registerQuickOpenProvider(p: QuickOpenProvider): Disposable // Ctrl+P 文件/符号快速打开
  registerSettingsSection(s: SettingsSection): Disposable    // 设置页分区贡献
  // —— 状态与能力 ——
  openPanel(seed, scope?): void; closePanel(id, scope?): void
  getSnapshot(): WorkbenchSnapshot; subscribeState(l): Disposable
  readonly version: string; readonly features: readonly string[]  // 单调能力探测
}
```

继承的原型精华：dedupeKey/single 打开去重、createTab 自定义铸造、badge 角标（廉价+吞错）、onOpen/onActivate/onClose 生命周期、visible 门（不可见暂停轮询）、孤儿面板占位恢复、`pkg:` 前缀 id 卫生。**不做** `ctx.betterSidebar` 形状兼容（社区表面，红线邻接；D4 决策项）。

### 6.2 Host 权威账本 + SSE（吸收 task-board 思想升级）

- 账本内容：任务中心数据、终端注册表投影、git 快照缓存、布局备份。全部带单调 `revision`。
- 推送：单一 `/workbench/events` SSE 通道**只发信令**（"某域 revision 变了"），客户端收到后按需拉取快照——避免推送风暴，天然幂等。
- 跨标签页选主：Web Locks + BroadcastChannel 选主，只有主标签页持有一条 SSE 连接，其余页经 BroadcastChannel 中继——不挤占浏览器对同一 host 的连接池上限（全家桶 shared/sse-leader 思想）。
- 持久化纪律：tmp+rename 原子写、目录锁 fail-closed、损坏文件隔离保留（task-board 思想）；存储根 `~/.dsh-zdsh`（治理栈先例，绝不写官方 ~/.dsh）。

### 6.3 布局持久化与会话隔离

- 主存：localStorage 按会话键（快路径，秒级恢复）；辅存：防抖同步到 host 账本（换机/清缓存恢复）。时间戳新者胜。
- 启动净化：未注册面板类型 → 占位卡（"提供者未加载"+关闭按钮），注册到位自动恢复（OrphanedTab 思想）。

### 6.4 设置框架

- 全局：官方设置页注册一级 section「工作台」，内部按功能包出卡（schema 驱动行控件：switch/text/number/select），存储走官方 settings 通道（第一方无 apiproxy 命名空间限制，无需全家桶式兼容桥）。
- 每 panel 卡：启用开关（缺省启用）+ 二级齿轮行（含插件自有键，JSON 可序列化）+ 自定义 render 逃生口。
- 总开关：关闭工作台 = dock 卸载 + 各面板 dispose，状态保留。

### 6.5 安全模型

1. 路径：所有 fs 操作过 realpath 门禁（workspace 根包含性检查，`!isAbsolute(rel)` 防 win32 跨盘 relative() 陷阱——gotcha #10）+ 写前"最新扫描路径"重校验 + tmp+rename 原子写 + symlink 目标类型解析。
2. SSRF：任何服务端代取 URL 仅 http/https；请求前校验 host，拒绝 localhost/环回/私有/保留地址（复用 omnivision PathPolicy 经验，Mimosa 验收条件固化）。
3. 浏览器/HTML 预览：不透明源沙箱 iframe 默认开（无 allow-same-origin/top-navigation、no-referrer、权限策略全禁），实时沙箱状态指示，解锁须显式且带警示；地址栏拒 javascript:/data:/file: 与本机地址。
4. 路由围栏：/workbench/* 全部复用 /api 同源信任围栏（Host 头环回或 trustedHosts，逐请求读活值）。
5. 终端：进程按会话键控 + 配额 + 重连宽限期；agent 工具绑定调用 agent 身份（模型永不传 sessionId），信号白名单。
6. Git：只调 CLI；push/pull/fetch 一律确认制弹窗；绝不设置身份。

### 6.6 性能预算

- 核心 chunk ≤400KB gzip；终端/编辑器/Mermaid/Office 为懒 chunk（用到才拉）。
- visible=false 停轮询停订阅；帧合批处理高频事件；虚拟滚动列表（大树/长日志）。
- SSE 单连接选主；WS 断线指数退避 + transcript 回放缓冲上限。

### 6.7 i18n

zh/en 内置，跟随官方 locale 实时切换；词典以中文为 key 源的类型化方案（全家桶经验），每包 NS 走 LocaleNamespaceMap 声明合并。

## 7. 功能规格清单

图例：🅰=吸收 web-ui 思想 🅱=吸收 better-sidebar 思想 ✚=我们的新增/改进 ｜ ◆v1=MVP 必交 ◇v1.x=同大版本跟进 ○=backlog（需用户决策或低优）

### 7.1 文件工作台（ui-workbench-files + viewers）◆v1
懒加载树 🅱✚软链目标语义语义🅱✚全局搜索🅱✚上传/拖放🅱✚悬浮 @引用🅱 ✚ **文件 watcher**（fs.watch 递归+防抖+SSE 增量推送，解决 better-sidebar 无 watcher 缺陷）✚ 右键菜单全套（新建/重命名/移动/删除/复制路径）✚ CodeMirror 6 编辑器多 tab + 原子保存 + dirty 指示 ✚ viewers：md(Mermaid strict 渲染)/img/pdf/html/code/binary-download 🅱 ✚ Office 三件套懒 chunk 内置（开箱即用但零启动成本；D2）✚ CSV/JSON 表格预览 ✚ head 4KB magic-bytes 嗅探重匹配 🅱

### 7.2 终端（ui-workbench-terminal + tools 包）◆v1
node-pty+xterm.js 真 shell 🅱 ✚ 配额/重连回放/shell 配置（Windows pwsh→powershell 探测）🅱 ✚ agent 工具×8 tmux 语义 🅱 ✚ **拖拽跨栏 portal 重挂父不重开 shell**（修 better-sidebar 重挂载缺陷）✚ 多标签+分栏内嵌 ✚ 连接失败横幅给出修复指引（Windows 构建链缺失场景）🅱

### 7.3 Git 中心（ui-workbench-git）◆v1
status/stage/unstage/commit(Ctrl+Enter)/discard/diff/log 🅱 ✚ VSCode 式 diff tab 🅱 ✚ 分支切换胶囊（状态条常驻）🅰 ✚ 图谱视图 🅰 ✚ **fetch/pull/push（确认制）**✚（补 better-sidebar 缺口）✚ host 侧门禁执行 git（白名单子命令）🅰

### 7.4 任务中心（ui-workbench-tasks）◆v1
子代理树实时拓扑+批量预览 🅱 ✚ 后台任务清单（退出码/实时输出/终止）🅱 ✚ 任务看板（Host 权威账本：真实会话执行+host cron+防睡眠+关浏览器结算）🅰 ✚ 新任务/子代理自动展开可关 🅱

### 7.5 浏览（ui-workbench-browse）◆v1
沙箱 iframe 多开 tab + 导航条 🅱 ✚ 协议分流可配 🅱 ✚ 聊天外链接管 🅱 ✚ X-Frame-Options 拒嵌原因面板 🅱

### 7.6 侧边对话（ui-workbench-sidechat）◇v1.x（先行 spike 验证会话种子可行性）
Codex 式侧线程=自建子会话，父日志诚实冻结副本（进行中回合→合成 interrupted 收尾；执行中工具调用→回退回合起点+结构化快照）🅱 ✚ 持续追问/冷恢复/提升为新会话 🅱

### 7.7 外壳体验（ui-workbench）◆v1
右侧 dock+底部面板双工作台+拖拽分栏/合并（跨面板）🅱 ✚ 移动端全宽抽屉 🅱 ✚ **命令面板 Ctrl/Cmd+Shift+P + 快捷键体系 + 快速打开 Ctrl/Cmd+P** ✚ 状态条（分支/任务数/终端配额）✚ 会话隔离布局+孤儿恢复 🅱 ✚ 声明式设置卡 🅱🅰 ✚ 能力探测 version+features 🅱

### 7.8 技能面板（ui-workbench-skills）◇v1.x
技能目录分级浏览/frontmatter 启停热刷新/创建与可恢复删除 🅰

### 7.9 Backlog（○，不进当前战役）
fork 式最近消息编辑（改历史语义，D3 待用户决策）；划选提问；对话大纲；SSH 套件；桌宠/皮肤（与全家桶重叠度低、优先级低）；远程访问。

## 8. 上游免疫设计（官方升级不影响分支功能）

### 8.1 接线面预算（≤8 个上游/共享文件，全部追加式）

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| 1 | `packages/bundle/web-app/package.json` | dependencies 追加 workspace 包 | 追加 |
| 2 | `packages/bundle/web-app/cordis.patch.yml` | 尾部追加 host 行 + `dsh.client` 花名册行（一个带注释块） | 追加 |
| 3 | `tsconfig.host.json` | references 追加 N 行 | 追加 |
| 4 | `tsconfig.client.json` | references 追加 N 行 | 追加 |
| 5 | `packages/api/remotes/src/client/index.ts` | remote $mount 数组追加一项 | 追加 |
| 6 | `knip.json` | 无测试包收口（尽量避免） | 视需要 |
| 7 | `pnpm-lock.yaml` / `THIRD_PARTY_NOTICES.md` | 工具自动再生成 | 自动 |
| 8 | `vitest.config.ts` | 仅当需要 windowsUnsupported/exempt 登记 | 尽量避免 |

不改写任何上游既有行；冲突面≈0，即使上游重排也可机械重放追加块。

### 8.2 契约测试（防漂移三道闸）

1. **装配契约 spec**：断言 patch 含 workbench 行集、roster 含全部 ui-workbench-*、remotes 挂载 workbench 面、slots 声明键齐全——上游重构破坏假设时响亮失败而非静默失联。
2. **manifest 一致性 spec**（better-sidebar 思想）：package.json ↔ patch 行 ↔ dsh.client 字段 ↔ exports 四方对账。
3. **真实挂载 e2e**：build → scratch profile 挂载 → `dsh web` 启动 → Playwright 无头断言 dock 渲染/开面板/基础流（两家共同做法，吸收为标准车道）。

### 8.3 版本与足迹维护

版本随分支统一 `-zDSH<date><letter>`；每次扩足迹重跑 `scripts/diff-with-official.mjs --out docs/dsh/diff-baseline.txt`；CHANGELOG 三联 + Agent Note 三联按仓库惯例落盘（lefthook 强制）。

## 9. 里程碑计划

| 里 程碑 | 内容 | 验收门 |
|---|---|---|
| M0 设计冻结 | 本文档评审定稿 + 关键 spike：①session 子会话种子 API（sidechat 前提）②fs.watch 在 win32 大树表现 ③node-pty 本机构建 | 用户确认规划；spike 结论落 docs/ |
| M1 外壳骨架 | workbench-host（路由+SSE+账本空壳+path-guard）+ ui-workbench（dock/panel/registry/设置卡/命令面板雏形）+ 1 个演示面板 | 全部登记完成；契约 spec①②绿；覆盖率达标 |
| M2 文件工作台 | explorer+editor+基础 viewers+watcher+上传 | 挂载 e2e：开树→打开文件→编辑保存→预览 |
| M3 终端 | pty 注册表+WS 回放+终端面板+agent 工具包 | e2e：开会话终端跑命令回显；工具 spec 全绿 |
| M4 Git 中心 | status/diff/log/commit/fetch/pull/push 确认制+分支胶囊 | 对真实仓库手工脚本 e2e |
| M5 任务中心 | 看板账本+子代理拓扑+后台任务 | 关浏览器结算 cron 测试 |
| M6 浏览+侧聊 | 沙箱浏览器；侧聊（若 M0 spike 通过） | 沙箱策略 spec；侧聊冻结语义 spec |
| M7 打磨 | 快捷键全集/i18n/移动端/lazy chunk 预算/技能面板 | 性能预算实测达标 |
| M8 集成与发布 | 默认启用接线+对抗验证（静态门禁/动态测试/红队评审 ×2 轮循环至零已知问题）+ CHANGELOG/diff-baseline/tag 推送 | 宪章 W5 流程全绿；开箱即用验收（全新 profile 装→可用） |

排期原则：每里程碑独立可合入（feature flag 未完成面板默认隐藏）；单里程碑内部再按"host 半→client 面→测试→接线"四步推进，适配无人值守代理接力（状态全部落盘 Plan/logs）。

## 10. 测试与质量策略

- 单元：各包 tests/**（vitex glob 硬约定），注册表生命周期/dedupe/viewer 匹配/能力门控专项 spec；覆盖率按仓库 100% 文件门禁提前规划豁免名单。
- 契约：§8.2 三道闸。
- e2e：Playwright 挂载真 profile 车道（吸收两家实践）。
- 对抗：宪章 W5 三法两轮以上循环至零已知问题；红队评审含**净室审查**（对照两仓库符号/文案/资源，确认零复制——R8 风险的专门关卡）。
- Windows 优先：本机 win32 即主开发验证环境（宪章 Windows 体验簇优先）；symlink/junction、CRLF、裸目录等 gotcha 按 R04 §9.2 清单执行。

## 11. 风险登记

| # | 风险 | 缓解 |
|---|---|---|
| R1 | node-pty Windows 原生构建失败 | 主流 Node 有预编译；失败降级横幅+修复指引（🅱 先例）；终端为可关面板不拖死外壳 |
| R2 | SSE/WS 连接池挤占 | Web Locks 选主单连接（§6.2） |
| R3 | 上游 rc.3+ 改 slot/session/Remote 形状 | 契约测试响亮失败 + 接线面仅 8 文件机械修复；spike 先行 |
| R4 | 范围蔓延 | 里程碑门禁+功能冻结清单（§7 图例即范围）；backlog 硬隔离 |
| R5 | 覆盖率 100% 门禁拖慢 | 豁免名单 M1 就申报；自绘组件优先纯函数化 |
| R6 | 侧聊子会话种子不可行 | M0 spike 前置；不可行则侧聊降级为"引用上下文的临时提问"轻量版或移出 v1.x |
| R7 | 性能回归 | 预算入 CI（chunk 体积断言）+visible 门从第一天生效 |
| R8 | 社区代码红线 | 净室流程：思想级参考（本规划即证据链）+M8 红队专审；API 形状/命名/资源全部原创 |
| R9 | token 成本 | 里程碑小步合入减少返工；子代理按精确任务书派发（记忆教训：拒绝开放式探索提示词） |

## 12. 决策项（已按授权选定默认值，评审时可推翻）

| # | 决策 | 默认值（理由） |
|---|---|---|
| D1 | 产品名 | zDSH 工作台 / workbench（中性、可扩展） |
| D2 | Office 预览 | 内置为懒 chunk（开箱即用且零启动成本） |
| D3 | fork 式历史编辑 | 不进 v1/v1.x（改会话历史语义，风险高；宪章要求此类功能用户拍板） |
| D4 | better-sidebar API 兼容 shim | 不做（社区表面形状，红线邻接；自有 API 已覆盖其全部能力点）。折中共存礼让：检测 `ctx.betterSidebar` 服务存在时设置页提示二选一（仅读服务键，不复刻任何接口） |
| D5 | 独立发布 | **用户 2026-08-24 拍板变更**：双形态都要——内核集成进分支默认启用 + 同源源码推 GitHub 独立仓库（`zsagi1368/zdsh-workbench`）作为独立插件分发；可移植性铁律见 §4.2 |

## 13. 附：研究文档索引

- docs/R04-zdsh-platform-extension-points.md —— Fork 扩展点与集成约束（完稿）
- docs/R05-dsh-web-ui-packages.md —— 全家桶 18 包逐包调研（子代理 A）
- docs/R06-dsh-web-ui-infra.md —— 全家桶基础设施/聚合/兼容范式（子代理 B）
- docs/R07-dsh-better-sidebar-analysis.md —— better-sidebar 深析
- sources/dsh-web-ui、sources/dsh-better-sidebar —— 克隆件（净室只读）

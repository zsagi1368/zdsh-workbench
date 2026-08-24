<div align="center">

# zDSH Workbench（zDSH 工作台）

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的 IDE 级停靠工作区**

文件 · 编辑器 · 终端 · Git · 任务 · 浏览 —— 外加一套扩展注册表，任何客户端插件都能以与内置功能完全对等的地位贡献面板和命令。

[![Release](https://img.shields.io/github/v/tag/zsagi1368/zdsh-workbench?label=release&sort=semver)](https://github.com/zsagi1368/zdsh-workbench/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![DSH](https://img.shields.io/badge/DSH-web%20profile-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

[快速开始](#快速开始) · [功能总览](#功能总览) · [配置项](#配置项) · [插件扩展](#在你的插件中接入) · [安全模型](#安全模型)

</div>

---

## 为什么需要 Workbench

DeepSeek Harness 给每个会话提供了对话界面；Workbench 给整个页面提供了工作区：右侧停靠栏里，会话触碰的文件、运行的终端、编辑的仓库、欠着的任务全部一击直达——布局独立持久化、原样恢复，并通过一个小巧的注册表 API 向其他插件开放。

## 功能总览

**🗂 文件** — 懒加载目录树，正确的软链接语义与失效链接标红；面包屑导航；名称搜索自动跳过 `node_modules`、`.git` 与隐藏目录；原子写入；图片 / PDF 内嵌预览；沙箱 HTML 预览；文本编辑，`Ctrl/Cmd+S` 保存。

**💻 终端** — `node-pty` 真 shell + xterm.js 渲染。每会话最多 3 个终端；断线重连时从服务端环形缓冲完整回放滚动缓冲区；shell 可配置（Windows 自动探测 pwsh → PowerShell）。

**🌿 Git** — 分支胶囊带 ahead/behind 计数、变更列表、内联彩色 diff、暂存/取消暂存、`Ctrl/Cmd+Enter` 提交、历史列表。网络操作（`fetch` / `pull` / `push`）永远先展示只读预览，显式确认后才执行。

**✅ 任务** — 三栏看板，宿主权威账本 + 单调 revision；崩溃安全的持久化（损坏文档隔离保存而非静默丢弃）；SSE 推送信号驱动多标签页同步刷新。

**🌐 浏览** — 基于不透明源 iframe 的多标签沙箱浏览器。脚本协议与内网地址在导航前即被拒绝；一键转交系统浏览器。

**⌘ 命令面板** — `Ctrl/Cmd+Shift+P`，模糊过滤、纯键盘操作。所有内置动作本身就是注册命令。

**📱 响应式** — 768px 以下自动切换为全宽抽屉。

## 快速开始

前置要求：Node.js ≥ 20、可正常运行的 [`dsh web`](https://github.com/deepseek-ai/deepseek-harness) profile。

```sh
git clone https://github.com/zsagi1368/zdsh-workbench.git
cd zdsh-workbench
pnpm install
pnpm approve-builds --all   # 放行 node-pty 的构建脚本
pnpm build
```

在 web profile 中注册 —— 编辑 `~/.dsh/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    "zdsh-workbench": "file:<本仓库的绝对路径>"
  }
}
```

然后在 profile 目录执行 `pnpm install`，重启 `dsh web` 并硬刷新浏览器（`Cmd/Ctrl+Shift+R`）。包内自带的 bundle patch 会自动追加挂载行。

打开任意对话，右侧即出现工作台。先在「文件」面板设置工作区根目录 —— Git 与终端都会跟随它。

## 配置项

宿主半选项写在挂载行的 `config:` 块（或 profile 补丁）中：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `trustedHosts` | `[]` | 服务暴露到环回之外时，信任围栏额外放行的 `host[:port]` 权威 |
| `allowedRoots` | 不限制 | 目录钳制：设置后，请求声明的 cwd 必须落在其中之一。端口可被 localhost 之外访问时建议开启 |
| `readLimitBytes` | `524288` | 单次文本读取上限（硬顶 8 MiB） |
| `writeBodyLimitBytes` | `134217728` | 请求体字节上限 |
| `listLimit` | `1000` | 单层目录列出行数 |
| `searchLimit` | `200` | 搜索结果截断阈值 |
| `watchDebounceMs` | `150` | 文件监视合并窗口 |
| `terminalsPerSession` | `3` | 每会话存活 PTY 上限 |
| `reconnectGraceMs` | `30000` | 断开终端等待重连的存活时间 |

## 在你的插件中接入

Workbench 发布了客户端 cordis 服务 `ctx.workbench`。内置面板走的正是同一套 API，第三方面板是一等公民：

```ts
// my-plugin/src/client/index.ts
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['workbench']

export function apply(ctx: Context): void {
  ctx.effect(() =>
    ctx.workbench.registerPanel({
      id: 'my-plugin:notes',
      title: 'Notes',
      order: 60,
      component: ({ visible }) => {
        // 页签未激活时 visible === false：在这里暂停轮询。
        return renderNotes()
      },
    }),
  )

  ctx.workbench.registerCommand({
    id: 'my-plugin:notes.new',
    title: 'Notes: new note',
    run: () => { /* ... */ },
  })
}
```

注册返回 disposer——请包在 `ctx.effect(...)` 里，卸载与热更新才会干净。采用新 API 前请检查 `ctx.workbench.features`（单调递增的能力清单），不要直接比较版本号。

### 键盘快捷键

| 操作 | 按键 |
|---|---|
| 命令面板 | `Ctrl/Cmd + Shift + P` |
| 编辑器保存 | `Ctrl/Cmd + S` |
| Git 提交 | `Ctrl/Cmd + Enter` |
| 关闭页签 | 页签标题旁的 `×` |

## 安全模型

- **全路由信任围栏。** JSON API、媒体字节、SSE、终端 WebSocket 全部执行与宿主 `/api` 网关一致的 Host 头信任策略（DNS 重绑定防御）。
- **每次操作实时校验工作区包含性。** 仅接受绝对路径；包含性按调用时的真实文件系统复核，含 symlink realpath 逃逸与 Windows 跨盘边界情况。
- **Git 仅以 argv 数组运行。** 无 shell 拼接、不写身份配置、不读系统级配置；网络动词一律预览后确认。
- **沙箱渲染。** 浏览器页签与 HTML 预览运行在不透明源 iframe 中（`sandbox=""`、无 referrer、空权限策略）；地址栏拒绝脚本协议与内网/环回地址。
- **可选部署钳制。** 设置 `allowedRoots` 即可将请求声明的 cwd 限定在白名单目录内。

## 开发

```sh
pnpm typecheck && pnpm build && pnpm test
```

测试套件包含启动真实 HTTP 服务器、操作真实临时 Git 仓库、端到端驱动任务账本的集成车道。`scripts/gen-xterm-css.mjs` 负责再生成内嵌的终端样式表，已挂入 `pnpm build`。

## FAQ

<details>
<summary><b>终端提示 node-pty 不可用</b></summary>

包管理器拦截了原生构建。在插件目录（或安装它的 profile 目录）执行：

```sh
pnpm approve-builds --all && pnpm rebuild node-pty
```

然后重启 `dsh web`。
</details>

<details>
<summary><b>升级后工作台没有出现</b></summary>

客户端半是热加载的：硬刷新浏览器一次（`Cmd/Ctrl+Shift+R`）。只有宿主半更新才需要重启进程。
</details>

## 路线图

- 侧边对话：把当前会话分叉成独立线程（平台的会话 fork API 让这件事非常干净）
- 基于 CodeMirror 的编辑器与渲染版 Markdown 视图
- 终端所有权与会话布局按会话作用域隔离
- 英文/中文之外的更多界面语言

## 许可证

[MIT](LICENSE) © zsagi1368

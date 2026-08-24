<div align="center">

# zDSH Workbench

**An IDE-grade dock workspace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**

Files · Editor · Terminal · Git · Tasks · Browse — plus an extension registry that lets any client plugin contribute panels and commands on equal footing with the built-ins.

[![Release](https://img.shields.io/github/v/tag/zsagi1368/zdsh-workbench?label=release&sort=semver)](https://github.com/zsagi1368/zdsh-workbench/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![DSH](https://img.shields.io/badge/DSH-web%20profile-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

[Getting started](#getting-started) · [Features](#features) · [Configuration](#configuration) · [Extending](#extending-your-plugin) · [Security](#security-model)

</div>

---

## Why Workbench

DeepSeek Harness gives every session a chat surface. Workbench gives the page a workspace: a right-hand dock where the files a session touches, the terminals it runs, the repository it edits, and the tasks it owes all live one click away — isolated per layout, restored exactly as you left them, and open to other plugins through one small registry api.

## Features

**🗂 Files** — lazy-loading directory tree with correct symlink semantics and dead-link flagging; breadcrumb navigation; name search that skips `node_modules`, `.git`, and hidden trees; atomic writes; inline previews for images and PDFs; sandboxed HTML preview; text editing with `Ctrl/Cmd+S` save.

**💻 Terminal** — real shells over `node-pty` rendered with xterm.js. Up to three terminals per session, reconnect with full scrollback replay from a server-side ring buffer, configurable shell (Windows probes pwsh → PowerShell automatically).

**🌿 Git** — branch pill with ahead/behind counts, change list, inline colored diffs, stage/unstage, `Ctrl/Cmd+Enter` commit, history list. Network actions (`fetch` / `pull` / `push`) always show a read-only preview and require explicit confirmation before running.

**✅ Tasks** — a three-column kanban backed by a host-authoritative ledger with monotonic revisions, crash-safe persistence (corrupt documents are quarantined, never silently dropped), and SSE push-signal refresh across tabs.

**🌐 Browse** — multi-tab sandboxed browser built on opaque-origin iframes. Scripting schemes and internal-network hosts are refused before navigation; hand-off to the system browser is one click away.

**⌘ Command palette** — `Ctrl/Cmd+Shift+P`, fuzzy-filtered, keyboard-driven. Every built-in action is itself a registered command.

**📱 Responsive** — below 768px the dock becomes a full-width drawer.

## Getting started

Requirements: Node.js ≥ 20, a working [`dsh web`](https://github.com/deepseek-ai/deepseek-harness) profile.

```sh
git clone https://github.com/zsagi1368/zdsh-workbench.git
cd zdsh-workbench
pnpm install
pnpm approve-builds --all   # allow node-pty's postinstall once
pnpm build
```

Register it in your web profile — in `~/.dsh/profiles/web/package.json`:

```jsonc
{
  "dependencies": {
    "zdsh-workbench": "file:<absolute path to this checkout>"
  }
}
```

Then run `pnpm install` inside the profile directory, restart `dsh web`, and hard-refresh the browser (`Cmd/Ctrl+Shift+R`). The bundle patch shipped in this package adds the mount row automatically.

Open any conversation and the dock appears on the right. Set a workspace root in the **Files** panel — Git and terminal follow it.

## Configuration

Host-half options go on the mount row's `config:` block (or your profile patch):

| Option | Default | Description |
|---|---|---|
| `trustedHosts` | `[]` | Extra `host[:port]` authorities admitted by the request fence when serving beyond loopback |
| `allowedRoots` | unrestricted | Directory clamp: when set, every request-declared cwd must resolve inside one of these roots. Recommended whenever the port is reachable beyond localhost |
| `readLimitBytes` | `524288` | Text read cap per call (hard ceiling 8 MiB) |
| `writeBodyLimitBytes` | `134217728` | Request body cap |
| `listLimit` | `1000` | Rows per directory listing |
| `searchLimit` | `200` | Search results before truncation |
| `watchDebounceMs` | `150` | File-watcher batch window |
| `terminalsPerSession` | `3` | Live PTYs per session |
| `reconnectGraceMs` | `30000` | How long a dropped terminal survives awaiting reconnect |

## Extending your plugin

Workbench publishes a client-side cordis service, `ctx.workbench`. Built-in panels register through exactly the same api, so third-party panels are first-class citizens:

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
        // `visible === false` while the tab is inactive: pause polling here.
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

Registration returns a disposer — wrap it in `ctx.effect(...)` so unload and hot reload stay clean. Check `ctx.workbench.features` (a monotonic capability list) instead of comparing versions when you adopt newer api.

### Keyboard shortcuts

| Action | Keys |
|---|---|
| Command palette | `Ctrl/Cmd + Shift + P` |
| Save file (editor) | `Ctrl/Cmd + S` |
| Commit message (Git panel) | `Ctrl/Cmd + Enter` |
| Close tab | `×` next to the tab title |

## Security model

- **Trust fence everywhere.** Every route — JSON api, media bytes, SSE, terminal WebSocket — enforces the same Host-header trust posture as the host's own `/api` gateway (DNS-rebinding defense).
- **Workspace containment on every operation.** Absolute paths only; containment re-checked against the live filesystem at call time, including symlink realpath escapes and Windows cross-drive edge cases.
- **Git runs argv-only.** No shell interpolation, no identity writes, no system config; network verbs are preview-then-confirm.
- **Sandboxed rendering.** Browser tabs and HTML previews run in opaque-origin iframes (`sandbox=""`, no referrer, empty permissions policy); the address bar refuses scripting schemes and private/loopback hosts.
- **Optional deployment clamp.** Set `allowedRoots` to confine every request-declared cwd to approved directories.

## Development

```sh
pnpm typecheck && pnpm build && pnpm test
```

The test suite includes integration lanes that boot real HTTP servers, operate real temporary git repositories, and drive the task ledger end-to-end. `scripts/gen-xterm-css.mjs` regenerates the vendored terminal stylesheet; it runs as part of `pnpm build`.

## FAQ

<details>
<summary><b>Terminal shows "node-pty unavailable"</b></summary>

Your package manager blocked the native build. Inside the plugin checkout (or the profile directory that installed it):

```sh
pnpm approve-builds --all && pnpm rebuild node-pty
```

Then restart `dsh web`.
</details>

<details>
<summary><b>The dock doesn't appear after updating</b></summary>

Client halves are hot-loaded; hard-refresh the browser once (`Cmd/Ctrl+Shift+R`). Only host-half updates need a process restart.
</details>

## Roadmap

- Side conversations: branch the current session into an independent thread (the platform's session-fork api makes this clean).
- CodeMirror-based editor and a rendered Markdown view.
- Session-scoped terminal ownership and layouts.
- Additional UI languages beyond English and Chinese.

## License

[MIT](LICENSE) © zsagi1368

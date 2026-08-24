# Changelog

All notable changes to zdsh-workbench are documented here. Format follows Keep a Changelog; versions are semver with pre-release tags.

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

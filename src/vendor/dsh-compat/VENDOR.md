# Vendored: @deepseek-ai/dsh-compat (index entry face)

- Provenance: deepseek-harness monorepo `packages/compat/dsh-compat` @ commit
  `30e4d503f4` (package version 0.1.5-rc.2), extracted read-only via `git archive`.
  - Path note (2026-09-29, append-only): the upstream path has since been rotated
    to `packages/zdsh/dsh-compat` (T2 migration `808c645298`); the line above is
    kept unrewritten as the extraction-time record.
- Why vendored: `@deepseek-ai/dsh-compat` is NOT published to npm (registry 404 as
  of 2026-09-27), so this standalone repo cannot depend on it. `src/compat.ts`
  consumes only `guardFeature` + `consoleCompatLogger` (the index entry), which
  comprise `probe.ts` + `guard.ts` and have ZERO external dependencies
  (node builtins only), making a verbatim vendor safe and self-contained.
- NOT vendored: `invariant.ts` (the `./invariant` entry) — it needs
  `@deepseek-ai/dsh-invariants` + host invariant wiring, which the workbench
  does not consume.
- Files are verbatim copies (headers intact) for traceability; do not edit here.
  On future host pin rotation, re-extract from the matching monorepo baseline.
- License: MIT (same as this repo).
- Re-verification record: 2026-09-29 re-verified byte-identical against zDSH-main
  4e571c427c (0.1.7-rc.2); provenance path rotated to packages/zdsh/dsh-compat
  (T2 migration 808c645298); files unchanged, no re-extraction diff.

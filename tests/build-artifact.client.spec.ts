/**
 * Factory-form artifact locks (O3 phase 1, design §2.3). The client bundle
 * must register with the host module loader (`window.__ModuleLoader__.load`)
 * under an id that is exactly the package name, wrap its exports in the
 * `factory(require)` closure, and must NOT regress to a plain-ESM shape;
 * the node half must stay plain ESM (the host imports it directly through
 * capabilities[].service.factory). lib/ absence fails loudly (readFileSync
 * throws) — the two runtime bundles are committed prebuilt artifacts, so a
 * missing lib/ means the build discipline broke, not "skip the leg".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function readArtifact(relative: string): string {
  return readFileSync(new URL(relative, `file://${repoRoot.replace(/\\/g, '/')}`), 'utf8')
}

function readPackageName(): string {
  const pkg = JSON.parse(readArtifact('package.json')) as { name?: string }
  if (typeof pkg.name !== 'string') throw new Error('package.json has no name')
  return pkg.name
}

describe('client bundle factory form (lib/client.js)', () => {
  const bundle = readArtifact('lib/client.js')
  const head = bundle.slice(0, 200)

  it('registers with the module loader under exactly the package name', () => {
    expect(head).toMatch(/window\.__ModuleLoader__\.load\(\{\s*id:\s*"zdsh-workbench"/)
    // Read-back assertion: the registered id must equal package.json "name"
    // (host boot graph keys client rows by the located manifest name) — no
    // second hardcoded literal is allowed to be the source of truth.
    const registered = /window\.__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(bundle)
    expect(registered?.[1]).toBe(readPackageName())
  })

  it('closes the factory with the module.exports return footer', () => {
    expect(bundle).toMatch(/return module\.exports;\s*\}\s*\}\);?\s*$/)
  })

  it('never regresses to the plain-ESM bare-import shape', () => {
    // The pre-O3 bundle started with `import … from "react"` — that shape
    // cannot execute inside the factory closure and must stay red forever.
    expect(head).not.toMatch(/^import\s.*from\s"react"/m)
    expect(head).not.toMatch(/^import\s.+from\s/m)
  })
})

describe('node bundle stays plain ESM (lib/index.js)', () => {
  it('is not factory-wrapped (the host imports it directly)', () => {
    const head = readArtifact('lib/index.js').slice(0, 200)
    expect(head).not.toContain('__ModuleLoader__')
  })
})

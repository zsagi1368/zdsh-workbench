/**
 * Three-way manifest consistency: package.json, dsh.plugin.json, and the
 * compiled-in protocol constant must agree on name and version. A drift here
 * ships a plugin whose loader row, client entry, and self-reported version
 * disagree — the failure mode this spec exists to make loud.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WORKBENCH_PACKAGE_NAME, WORKBENCH_PLUGIN_ID, WORKBENCH_VERSION } from '../src/shared/protocol.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relative, `file://${repoRoot.replace(/\\/g, '/')}`), 'utf8')) as Record<string, unknown>
}

describe('manifest consistency', () => {
  const pkg = readJson('package.json')
  const plugin = readJson('dsh.plugin.json')

  it('keeps package.json and dsh.plugin.json on one version', () => {
    expect(plugin.version).toBe(pkg.version)
  })

  it('keeps the compiled-in protocol constant on that version', () => {
    expect(WORKBENCH_VERSION).toBe(pkg.version)
  })

  it('uses the same plugin id and package name everywhere', () => {
    expect(plugin.id).toBe(WORKBENCH_PLUGIN_ID)
    expect(pkg.name).toBe(WORKBENCH_PACKAGE_NAME)
    const main = plugin.main as string | undefined
    expect(main).toBe('./lib/index.js')
    const client = (plugin.client as { main?: string } | undefined)?.main
    expect(client).toBe('./lib/client.js')
  })

  it('declares the bundle patch the installer reconciles', () => {
    expect((pkg.dsh as Record<string, unknown> | undefined)).toBeDefined()
    const bundle = (pkg.dsh as { bundle?: { patch?: string } }).bundle
    expect(bundle?.patch).toBe('./cordis.patch.yml')
  })
})

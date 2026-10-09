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

  it('declares the package exports the loader mounts', () => {
    const exportsMap = pkg.exports as Record<string, { default?: string }> | undefined
    expect(exportsMap?.['.']?.default).toBe('./lib/index.js')
    expect(exportsMap?.['./client']?.default).toBe('./lib/client.js')
  })
})

/**
 * O3 factory-onboarding governance face (design §2.1/§2.2/§2.5): the `dsh`
 * block is what zDSH governance admission and the client-modules roster
 * actually consume. Every lock below pins a field the mount chain reads —
 * a silent drift here means the seeded artifact is admitted with a
 * different contract than the one reviewed.
 */
describe('dsh governance declaration (package.json "dsh")', () => {
  const pkg = readJson('package.json')
  const plugin = readJson('dsh.plugin.json')
  const dsh = pkg.dsh as {
    compatible?: string
    autoApprove?: boolean
    capabilities?: Array<{ type?: string; service?: { name?: string; factory?: string; singleton?: boolean } }>
    sandbox?: { type?: string; process?: { spawn?: boolean; exec?: boolean; allowedCommands?: string[] } }
    client?: { platform?: string; inject?: unknown[] }
  }

  it('pins the compatibility window and autoApprove to the factory-set form', () => {
    expect(dsh.compatible).toBe('>=0.1.5-rc.2 <0.3.0')
    expect(dsh.autoApprove).toBe(true)
  })

  it('declares exactly one service capability pointing at the node-half factory exit', () => {
    expect(dsh.capabilities).toHaveLength(1)
    const capability = dsh.capabilities?.[0]
    expect(capability?.type).toBe('service')
    // The mount chain only reads capabilities[].service.factory
    // (preinstaller resolveFactoryUrls); no factory => row skipped.
    expect(capability?.service?.factory).toBe('./lib/index.js')
    expect(capability?.service?.name).toBe('zdsh-workbench/server')
    expect(capability?.service?.singleton).toBe(true)
  })

  it('declares the client roster face: web platform with an empty inject list', () => {
    // The client half has zero runtime @deepseek-ai value imports (all
    // type-only); externals are PLATFORM_MODULES baseline words only.
    expect(dsh.client?.platform).toBe('web')
    expect(dsh.client?.inject).toEqual([])
  })

  it('declares the sandbox face honestly: spawn=true with the enforceable command list', () => {
    expect(dsh.sandbox?.type).toBe('inline')
    expect(dsh.sandbox?.process?.spawn).toBe(true)
    expect(dsh.sandbox?.process?.exec).toBe(false)
    expect(dsh.sandbox?.process?.allowedCommands).toContain('git')
    expect(dsh.sandbox?.process?.allowedCommands).toEqual([
      'git', 'where.exe', 'pwsh.exe', 'powershell.exe', 'cmd.exe', 'bash',
    ])
  })

  it('keeps the dsh.plugin.json legacy pointer on the same client entry (dual-track cross-lock)', () => {
    // dsh.plugin.json is retained untouched (design D-O3-2): runtime
    // consumers read package.json "dsh"; the legacy manifest is an
    // independent-ecosystem identity face. This lock stops the two
    // client-entry pointers from drifting apart.
    const exportsMap = pkg.exports as Record<string, { default?: string }>
    const legacyClientMain = (plugin.client as { main?: string } | undefined)?.main
    expect(legacyClientMain).toBe(exportsMap?.['./client']?.default)
  })
})

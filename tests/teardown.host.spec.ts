/**
 * RA1d-family domain teardown (O3 phase 1, design §2.4). Unloading the
 * workbench fiber must release the three domain resources the route effects
 * do not own: pty child processes (PtyRegistry.disposeAll), fs watcher
 * handles (FsWatcherManager.closeAll), and the task-ledger→SSE subscription.
 *
 * Unit leg: disposeAll kills every held terminal (fake spawner, no real pty).
 * Integration leg: apply() is driven through a fake ctx whose `effect`
 * captures disposers (cordis fiber-unload semantics); the SSE channel is
 * exercised over a real temp workspace with real fs.watch, then every
 * captured disposer runs and the channel must go silent — no fs frames, no
 * task pings — while a remount comes back clean. The fake `register`
 * deliberately returns a no-op disposer so the routes stay callable after
 * teardown: that isolates the domain-teardown observations (route
 * withdrawal is already effect-wired and covered by the routes' own
 * disposer contract).
 *
 * TaskLedger persists under DSH_BRANCH_HOME (env-derived storage root), so
 * the whole lane stubs it into a scratch dir — never the real user home.
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { PtyRegistry } from '../src/pty-registry.ts'
import type { WebRoute } from '../src/context-types.ts'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('PtyRegistry.disposeAll (teardown contract)', () => {
  it('kills every held terminal, clears session counts, and is idempotent', () => {
    let killed = 0
    const registry = new PtyRegistry({
      reconnectGraceMs: 50,
      shellResolver: () => ({ file: 'powershell.exe', args: ['-NoLogo'] }),
      spawner: () => ({
        pid: 4242,
        write: () => {},
        resize: () => {},
        kill: () => {
          killed += 1
        },
      }),
    })
    const events = { onData: () => {}, onExit: () => {} }
    expect(registry.open('s1', 't1', events)).not.toHaveProperty('error')
    expect(registry.open('s1', 't2', events)).not.toHaveProperty('error')
    expect(registry.open('s2', 't1', events)).not.toHaveProperty('error')

    registry.disposeAll()
    expect(killed).toBe(3)
    expect(registry.countFor('s1')).toBe(0)
    expect(registry.countFor('s2')).toBe(0)

    registry.disposeAll() // second call: nothing held, nothing killed
    expect(killed).toBe(3)
  })
})

describe('apply() domain teardown wiring (RA1d)', () => {
  let scratch = ''

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'wb-teardown-'))
    // TaskLedger storage root must never resolve into the real user home.
    vi.stubEnv('DSH_BRANCH_HOME', scratch)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(scratch, { recursive: true, force: true })
  })

  interface FakeCtx {
    ctx: Context
    disposers: Array<() => void>
    routes: WebRoute[]
    upgradePaths: string[]
  }

  function makeFakeCtx(): FakeCtx {
    const disposers: Array<() => void> = []
    const routes: WebRoute[] = []
    const upgradePaths: string[] = []
    const ctx = {
      effect: (setup: () => unknown) => {
        const disposer = setup()
        if (typeof disposer === 'function') disposers.push(disposer as () => void)
      },
      webServer: {
        register: (route: WebRoute) => {
          routes.push(route)
          return () => {}
        },
        registerUpgrade: (route: { path: string }) => {
          upgradePaths.push(route.path)
          return () => {}
        },
      },
    } as unknown as Context
    return { ctx, disposers, routes, upgradePaths }
  }

  function makeSse(roots: string[]): { req: IncomingMessage; res: ServerResponse; written: string[] } {
    const written: string[] = []
    const req = Object.assign(new EventEmitter(), {
      headers: { host: '127.0.0.1:8787' }, // loopback: passes the trust fence
      url: `/workbench/events?roots=${encodeURIComponent(JSON.stringify(roots))}`,
      method: 'GET',
    }) as unknown as IncomingMessage
    const res = {
      writeHead: () => {},
      write: (chunk: unknown) => {
        written.push(String(chunk))
        return true
      },
      destroy: () => {},
    } as unknown as ServerResponse
    return { req, res, written }
  }

  async function apiCall(route: WebRoute, method: string, payload: unknown): Promise<string> {
    const body = Buffer.from(JSON.stringify(payload))
    const req = Object.assign(Readable.from([body]), {
      headers: { host: '127.0.0.1:8787' },
      url: `/workbench/api/${encodeURIComponent(method)}`,
      method: 'POST',
    }) as unknown as IncomingMessage
    let ended = ''
    const res = {
      writeHead: () => {},
      end: (chunk?: unknown) => {
        ended = chunk === undefined ? '' : String(chunk)
      },
    } as unknown as ServerResponse
    await route.handler(req, res)
    return ended
  }

  async function expectFrame(written: string[], needle: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (written.join('').includes(needle)) return
      await sleep(50)
    }
    throw new Error(`teardown spec timed out waiting for an SSE frame containing ${needle}`)
  }

  async function mountWithSse(workspace: string): Promise<{ fake: FakeCtx; sse: ReturnType<typeof makeSse>; apiRoute: WebRoute }> {
    const fake = makeFakeCtx()
    await apply(fake.ctx, {})
    const sseRoute = fake.routes.find(route => route.kind === 'exact' && route.path === '/workbench/events')
    const apiRoute = fake.routes.find(route => route.kind === 'prefix' && route.path === '/workbench/api/')
    expect(sseRoute, 'events route must be registered').toBeDefined()
    expect(apiRoute, 'api route must be registered').toBeDefined()
    expect(fake.upgradePaths).toContain('/workbench/ws/terminal')
    const sse = makeSse([workspace])
    await sseRoute!.handler(sse.req, sse.res)
    return { fake, sse, apiRoute: apiRoute! }
  }

  it('fiber dispose closes watchers and releases the task subscription; remount is clean', async () => {
    const workspace = await mkdtemp(join(scratch, 'ws-'))

    // --- mount #1: prove the live pipeline first (control legs) ---
    const first = await mountWithSse(workspace)
    await writeFile(join(workspace, 'before.txt'), 'control')
    await expectFrame(first.sse.written, '"domain":"fs"')

    const created = await apiCall(first.apiRoute, 'tasks.create', { title: 'teardown probe' })
    expect(created).toContain('"ok":true')
    await expectFrame(first.sse.written, '"domain":"tasks"')

    // --- fiber unload: run every captured effect disposer ---
    expect(first.fake.disposers.length).toBeGreaterThan(0)
    for (const dispose of first.fake.disposers) dispose()
    const mark = first.sse.written.length

    // Same stimuli as the control legs — the channel must stay silent now:
    // watchers are closed (no fs frames) and the ledger subscription is
    // released (task commits no longer ping SSE). The api route is still
    // callable because the fake register returns a no-op disposer.
    await writeFile(join(workspace, 'after.txt'), 'post-teardown')
    const after = await apiCall(first.apiRoute, 'tasks.create', { title: 'post teardown' })
    expect(after).toContain('"ok":true') // the ledger itself still works
    await sleep(600) // > debounce (150ms) + watcher latency; control proved delivery is fast
    const tail = first.sse.written.slice(mark).join('')
    expect(tail).not.toContain('"domain":"fs"')
    expect(tail).not.toContain('"domain":"tasks"')

    // --- mount #2: remount comes back clean (no cross-mount leakage) ---
    const second = await mountWithSse(workspace)
    await writeFile(join(workspace, 'remount.txt'), 'remounted')
    await expectFrame(second.sse.written, '"domain":"fs"')
    for (const dispose of second.fake.disposers) dispose()
  })
})

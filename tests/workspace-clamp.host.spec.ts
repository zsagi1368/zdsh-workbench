/**
 * The deployment workspace clamp (`allowedRoots`) must bind EVERY surface
 * that accepts a request-declared cwd: JSON fs methods, git methods, the
 * SSE watcher registration, and the media byte route.
 */
import { createServer, type Server } from 'node:http'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest'
import { apply } from '../src/index.ts'
import type { WebRoute } from '../src/context-types.ts'

let inside = ''
let outside = ''
let server: TestServer

interface TestServer {
  baseUrl: string
  close(): Promise<void>
}

async function startClamped(clampRoot: string): Promise<TestServer> {
  const routes: WebRoute[] = []
  const fakeCtx = {
    effect: (fn: () => unknown) => fn(),
    webServer: {
      register(route: WebRoute) {
        routes.push(route)
        return () => {}
      },
      registerUpgrade() {
        return () => {}
      },
    },
  } as unknown as Context
  await apply(fakeCtx, { allowedRoots: [clampRoot] })
  const httpServer: Server = createServer((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const parsed = new URL(req.url ?? '/', 'http://workbench.invalid')
    const exact = routes.find(route => route.kind === 'exact' && route.path === parsed.pathname)
    const prefix = routes
      .filter(route => route.kind === 'prefix' && parsed.pathname.startsWith(route.path))
      .sort((a, b) => b.path.length - a.path.length)[0]
    const handler = exact?.handler ?? prefix?.handler
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolveListen => httpServer.listen(0, '127.0.0.1', resolveListen))
  const address = httpServer.address()
  return {
    baseUrl: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`,
    close: () =>
      new Promise((resolveClose) => {
        httpServer.close(() =>{  resolveClose() })
      }),
  }
}

async function api<T>(method: string, payload?: unknown, baseUrl: string = server.baseUrl): Promise<T> {
  const response = await fetch(`${baseUrl}/workbench/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  return (await response.json()) as T
}

type ClampLegOutcome =
  | { status: 'exercised'; spelling: string }
  | { status: 'unavailable'; spelling: string; reason: string }

/**
 * Exercise ONE host spelling of the workspace root against the clamp.
 *
 * The clamp is resolved on the BOOT side and every request root on the REQUEST
 * side (RootCache -> fs/promises.realpath, see resolveWorkspaceRoot); both MUST
 * land in one coordinate. On win32 the sync API is purely lexical — it keeps
 * 8.3 short-name components (GH Windows runners: TEMP=C:\Users\RUNNER~1\...)
 * and the caller's letter case — while the promise API resolves through the
 * filesystem and expands both. A sync-canonicalized clamp therefore never
 * lexically contains a promise-canonicalized request root there, and every
 * inside request is refused as outside-workspace.
 *
 * A spelling the host does not offer (no 8.3 generation, case-sensitive
 * volume) is reported as `unavailable` so the caller can skip and LOG that
 * specific leg — the coverage source stays visible in the CI log instead of
 * the case degrading silently into an unlabelled green.
 * @param requestRoot - the request-side workspace root (the canonical temp dir).
 * @param spelling - the boot-side clamp spelling under test (short name / case variant).
 * @returns which leg ran and, when it did not, why the host cannot offer it.
 */
async function runClampLeg(requestRoot: string, spelling: string): Promise<ClampLegOutcome> {
  const canonical = await realpath(requestRoot)
  if (spelling === canonical) {
    return { status: 'unavailable', spelling, reason: 'this host already spells the workspace root canonically' }
  }
  // Only a spelling the filesystem itself resolves to the request root is a
  // coordinate mismatch; any other spelling names a different directory.
  const sameTarget = await realpath(spelling).then(resolved => resolved === canonical, () => false)
  if (!sameTarget) {
    return { status: 'unavailable', spelling, reason: 'this spelling resolves to a different location (or not at all)' }
  }
  const clamped = await startClamped(spelling)
  try {
    const result = await api<{ ok: boolean; value?: { content: string } }>(
      'fs.read',
      { cwd: requestRoot, path: join(requestRoot, 'ok.txt') },
      clamped.baseUrl,
    )
    expect(result.ok, `clamp ${spelling} must admit the long-form request root`).toBe(true)
    expect(result.value?.content).toBe('in')
  } finally {
    await clamped.close()
  }
  return { status: 'exercised', spelling }
}

/**
 * Make one leg's coverage source visible in whatever reporter runs it. The
 * `console.log` is the load-bearing part for CI: the default reporter prints
 * captured stdout attributed to the exact case name, whereas annotations only
 * surface in structured reporters (junit/html).
 * @param ctx - test context (annotate/skip) of the leg being reported.
 * @param shape - host shape label of the leg.
 * @param outcome - what runClampLeg found on this host.
 */
async function reportClampLeg(ctx: Pick<TestContext, 'annotate' | 'skip'>, shape: string, outcome: ClampLegOutcome): Promise<void> {
  const detail =
    outcome.status === 'exercised'
      ? `exercised, boot-side clamp spelled ${outcome.spelling}`
      : `skipped, ${outcome.reason}: ${outcome.spelling}`
  console.log(`[coverage] clamp coordinate leg "${shape}": ${detail}`)
  await ctx.annotate(`clamp coordinate leg "${shape}": ${detail}`, 'coverage')
  if (outcome.status === 'unavailable') {
    ctx.skip(`clamp coordinate leg "${shape}": ${outcome.reason}`)
  }
}

beforeEach(async () => {
  inside = await mkdtemp(join(tmpdir(), 'wb-in-'))
  outside = await mkdtemp(join(tmpdir(), 'wb-out-'))
  await writeFile(join(inside, 'ok.txt'), 'in')
  await writeFile(join(outside, 'secret.txt'), 'out')
  await mkdir(join(outside), { recursive: true })
  server = await startClamped(inside)
})

afterEach(async () => {
  await server.close()
  await rm(inside, { recursive: true, force: true }).catch(() => {})
  await rm(outside, { recursive: true, force: true }).catch(() => {})
})

describe('deployment workspace clamp', () => {
  it('allows reads whose cwd is inside the clamp', async () => {
    const result = await api<{ ok: boolean; value?: { content: string } }>('fs.read', { cwd: inside, path: join(inside, 'ok.txt') })
    expect(result.ok).toBe(true)
    expect(result.value?.content).toBe('in')
  })

  it('rejects fs reads declared against an outside cwd', async () => {
    const result = await api<{ ok: boolean; error?: { code: string } }>('fs.read', { cwd: outside, path: join(outside, 'secret.txt') })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('outside-workspace')
  })

  it('rejects git operations against an outside cwd', async () => {
    const result = await api<{ ok: boolean; error?: { code: string } }>('git.status', { cwd: outside })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('outside-workspace')
  })

  it('refuses the media byte route for an outside cwd', async () => {
    const url = `${server.baseUrl}/workbench/file?cwd=${encodeURIComponent(outside)}&path=${encodeURIComponent(join(outside, 'secret.txt'))}`
    const response = await fetch(url)
    expect(response.status).toBe(403)
  })

  // One case per host shape on purpose: the reporter then names each leg, so a
  // leg this host cannot offer is skipped with its own label and logs a
  // `[coverage]` line naming the shape, instead of both legs collapsing into a
  // single result whose coverage source is invisible in the CI log.
  describe('admits inside requests when the clamp lands in the request-side canonical coordinate', () => {
    // The 8.3 short-name spelling (GH Windows runners: TEMP=C:\Users\RUNNER~1\...)
    // is the shape that really breaks the boot/request coordinate; the
    // case-variant spelling is its stand-in on hosts without 8.3 aliasing.
    it('8.3 short-name spelling leg', async ({ annotate, skip }) => {
      await reportClampLeg({ annotate, skip }, '8.3 short-name spelling', await runClampLeg(inside, realpathSync(inside)))
    })

    it('case-variant spelling leg', async ({ annotate, skip }) => {
      await reportClampLeg({ annotate, skip }, 'case-variant spelling', await runClampLeg(inside, inside.toUpperCase()))
    })
  })

  // Note: SSE watcher-root filtering lives in the events route (roots are
  // resolved through the same rootCache + clamp before addRoots); asserting
  // it over real sockets belongs to the mount-e2e lane, not unit tests.
})

/**
 * Workbench host half. Owns the `/workbench` HTTP prefix and the
 * `/workbench/events` SSE channel. Every request passes the browser-trust
 * fence (see trust.ts) before any work happens. API responses share one
 * envelope (`shared/protocol-envelope.ts`); unknown methods answer with
 * `no-route` on HTTP 200 so transport status stays reserved for transport.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { WORKBENCH_ROUTE_PREFIX as PREFIX, pingResult } from '../shared/protocol.ts'
import type { WorkbenchRouteEnvelope } from '../shared/protocol-envelope.ts'
import type { WebRoute } from './context-types.ts'
import './context-types.ts'
import { createGitHandlers } from './git-routes.ts'
import { createFsHandlers, readBody, RootCache } from './fs-routes.ts'
import { TaskLedger } from './task-ledger.ts'
import { FsWatcherManager } from './fs-watch.ts'
import { PtyRegistry } from './pty-registry.ts'
import { acceptTerminalSocket } from './terminal-route.ts'
import { assertTrustedAuthorityEntry, isTrustedRequestHost } from './trust.ts'

/** Services required from the host composition. */
export const inject = ['webServer']

/** Deployment options for the host half (cordis plugin row `config`). */
export interface WorkbenchHostConfig {
  /**
   * Additional trusted authorities (`host` or `host:port`) allowed past the
   * Host fence when DSH serves beyond loopback. Must mirror the deployment's
   * own trusted-host posture; entries are validated loudly at load time.
   */
  trustedHosts?: string[]
  /** Text read cap per `fs.read`. Clamped hard at 8 MiB. */
  readLimitBytes?: number
  /** Request-body byte cap (also bounds writes). */
  writeBodyLimitBytes?: number
  /** Directory listing row bound per level. */
  listLimit?: number
  /** Search result bound before truncation. */
  searchLimit?: number
  /** Watcher batch window in milliseconds. */
  watchDebounceMs?: number
  /** Terminals one session may hold open at once. */
  terminalsPerSession?: number
  /** How long a disconnected terminal survives awaiting a reconnect (ms). */
  reconnectGraceMs?: number
}

const DEFAULTS = {
  readLimitBytes: 512 * 1024,
  writeBodyLimitBytes: 128 * 1024 * 1024,
  listLimit: 1000,
  searchLimit: 200,
  watchDebounceMs: 150,
} as const

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function fail(code: string, message: string): WorkbenchRouteEnvelope<never> {
  return { ok: false, error: { code, message } }
}

export function apply(ctx: Context, options?: WorkbenchHostConfig): void {
  const trustedHosts = options?.trustedHosts ?? []
  for (const entry of trustedHosts) assertTrustedAuthorityEntry(entry)

  const readLimitBytes = options?.readLimitBytes ?? DEFAULTS.readLimitBytes
  const bodyCap = options?.writeBodyLimitBytes ?? DEFAULTS.writeBodyLimitBytes
  const watchers = new FsWatcherManager({ debounceMs: options?.watchDebounceMs ?? DEFAULTS.watchDebounceMs })
  const ptyRegistry = new PtyRegistry({
    terminalsPerSession: options?.terminalsPerSession,
    reconnectGraceMs: options?.reconnectGraceMs,
  })
  const rootCache = new RootCache()
  const handlers = createFsHandlers(rootCache, {
    readLimitBytes,
    listLimit: options?.listLimit ?? DEFAULTS.listLimit,
    searchLimit: options?.searchLimit ?? DEFAULTS.searchLimit,
  })
  const gitHandlers = createGitHandlers({ rootCache })

  const taskLedger = new TaskLedger()
  const tasksReady = taskLedger.init().catch(() => {})
  const taskHandlers: Record<string, (payload: unknown) => Promise<WorkbenchRouteEnvelope<unknown>>> = {
    'tasks.list': async () => taskLedger.list(),
    'tasks.create': async (payload) => taskLedger.create(payload),
    'tasks.update': async (payload) => taskLedger.update(payload),
    'tasks.delete': async (payload) => taskLedger.remove(payload),
  }

  // Task changes ride the existing SSE channel so every page stays current.
  taskLedger.subscribe((frame) => {
    watchers.broadcast(frame)
  })

  const dispatch = async (method: string, payload: unknown): Promise<WorkbenchRouteEnvelope<unknown>> => {
    if (method === 'ping') return envelopeValue(pingResult())
    await tasksReady
    const handler = handlers.get(method)
      ?? gitHandlers.get(method)
      ?? taskHandlers[method]
    if (handler === undefined) return fail('no-route', `unknown workbench method ${method}`)
    return handler(payload)
  }

  function envelopeValue<T>(value: T): WorkbenchRouteEnvelope<T> {
    return { ok: true, value }
  }

  const apiRoute: WebRoute = {
    kind: 'prefix',
    path: `${PREFIX}/api/`,
    handler: async (req, res) => {
      if (!isTrustedRequestHost(req.headers, trustedHosts)) {
        respondJson(res, 403, fail('untrusted-host', 'host header failed the trust fence'))
        return
      }
      const url = new URL(req.url ?? '/', 'http://workbench.invalid')
      const method = decodeURIComponent(url.pathname.slice(`${PREFIX}/api/`.length))
      let payload: unknown = {}
      try {
        if (req.method === 'POST') {
          const body = await readBody(req, bodyCap)
          payload = body.byteLength === 0 ? {} : JSON.parse(body.toString('utf8'))
        } else {
          const raw = url.searchParams.get('payload')
          payload = raw === null ? {} : JSON.parse(raw)
        }
      } catch (cause) {
        const message = cause instanceof Error && cause.message === 'body-too-large'
          ? 'request body exceeds the configured cap'
          : 'request body is not valid JSON'
        const code = cause instanceof Error && cause.message === 'body-too-large' ? 'too-large' : 'bad-request'
        respondJson(res, 200, fail(code, message))
        return
      }
      try {
        respondJson(res, 200, await dispatch(method, payload))
      } catch (cause) {
        // A handler throwing instead of enveloping is a bug; keep the
        // process alive and report it loudly to the caller.
        respondJson(res, 200, fail('handler-crash', cause instanceof Error ? cause.message : String(cause)))
      }
    },
  }

  const eventsRoute: WebRoute = {
    kind: 'exact',
    path: `${PREFIX}/events`,
    handler: async (req, res) => {
      if (!isTrustedRequestHost(req.headers, trustedHosts)) {
        respondJson(res, 403, fail('untrusted-host', 'host header failed the trust fence'))
        return
      }
      const url = new URL(req.url ?? '/', 'http://workbench.invalid')
      let roots: unknown
      try {
        roots = JSON.parse(url.searchParams.get('roots') ?? '[]')
      } catch {
        roots = null
      }
      if (!Array.isArray(roots)) {
        res.destroy()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const unsubscribe = watchers.subscribe((frame) => {
        try {
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
        } catch {
          req.destroy()
        }
      })
      const addDisposer = watchers.addRoots(roots.filter((root): root is string => typeof root === 'string'))
      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n')
        } catch {
          req.destroy()
        }
      }, 25_000)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()
      req.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
        addDisposer()
      })
    },
  }

  ctx.effect(() => ctx.webServer.register(apiRoute), 'workbench: /workbench/api routes')
  ctx.effect(() => ctx.webServer.register(eventsRoute), 'workbench: /workbench/events sse')
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: `${PREFIX}/ws/terminal`,
    handler: (req, socket, head) => {
      if (!isTrustedRequestHost(req.headers, trustedHosts)) {
        socket.destroy()
        return
      }
      acceptTerminalSocket(ptyRegistry, req, socket, head)
    },
  }), 'workbench: terminal ws upgrade')
}

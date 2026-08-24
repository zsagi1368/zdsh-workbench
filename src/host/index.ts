/**
 * Workbench host half. Owns the `/workbench` HTTP prefix: every route passes
 * the browser-trust fence (see trust.ts) before any work happens, and every
 * answer is JSON with stable error shapes. M1 skeleton registers exactly one
 * route family — the liveness probe — and grows the fs/git/pty/ledger routes
 * behind the same fence in later milestones.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { WORKBENCH_ROUTE_PREFIX, pingResult } from '../shared/protocol.ts'
import type { WebRoute } from './context-types.ts'
import './context-types.ts'
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
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function apply(ctx: Context, options?: WorkbenchHostConfig): void {
  const trustedHosts = options?.trustedHosts ?? []
  for (const entry of trustedHosts) assertTrustedAuthorityEntry(entry)

  const route: WebRoute = {
    kind: 'prefix',
    path: WORKBENCH_ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedRequestHost(req.headers, trustedHosts)) {
        respondJson(res, 403, { ok: false, error: { code: 'untrusted-host', message: 'host header failed the trust fence' } })
        return
      }
      const url = new URL(req.url ?? '/', 'http://workbench.invalid')
      if (url.pathname === `${WORKBENCH_ROUTE_PREFIX}/api/ping`) {
        respondJson(res, 200, pingResult())
        return
      }
      respondJson(res, 404, { ok: false, error: { code: 'no-route', message: `unknown workbench route ${url.pathname}` } })
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'workbench: /workbench prefix route')
}

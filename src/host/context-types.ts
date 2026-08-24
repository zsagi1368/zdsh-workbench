/**
 * The slice of the host runtime this plugin's Node half consumes, declared
 * structurally so the plugin compiles against the published SDK types
 * without owning them. Route shapes mirror `@deepseek-ai/dsh-host-webserver`.
 */
import type { IncomingMessage } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** A named HTTP route: exact or longest-prefix match, handler owns the response. */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** An upgrade route matched on exact pathname; the handler owns the raw socket. */
export interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/**
 * The `webServer` service face. Registration returns a disposer; registering
 * a duplicate path throws at composition time by contract.
 */
export interface WebServerFace {
  register(route: WebRoute): () => void
  registerUpgrade(route: WebUpgradeRoute): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServerFace
  }
}

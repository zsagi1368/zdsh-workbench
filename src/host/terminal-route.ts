/**
 * Terminal WebSocket route: thin glue between `/workbench/ws/terminal`
 * frames and the PTY registry. Message semantics live in
 * `createTerminalMessenger` (unit-tested); the socket layer here only
 * parses, dispatches, and cleans up on disconnect.
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { TerminalClientMessage, TerminalServerMessage } from '../shared/terminal-protocol.ts'
import type { PtyRegistry } from './pty-registry.ts'

/**
 * Pure message handler: one client message in, zero or more server messages
 * out (plus side effects on the registry). Async because `open` may wait on
 * the lazy native-module load.
 */
export function createTerminalMessenger(registry: PtyRegistry) {
  const send = (socket: WebSocket, message: TerminalServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  return {
    async handle(socket: WebSocket, raw: unknown): Promise<void> {
      let parsed: TerminalClientMessage
      try {
        parsed = JSON.parse(String(raw)) as TerminalClientMessage
      } catch {
        send(socket, { t: 'error', code: 'bad-frame', message: 'frame is not valid JSON' })
        return
      }
      const { sessionId, termId } = parsed as TerminalClientMessage
      if (typeof sessionId !== 'string' || typeof termId !== 'string') {
        send(socket, { t: 'error', code: 'bad-frame', message: 'sessionId and termId are required' })
        return
      }

      switch (parsed.t) {
        case 'open': {
          const result = registry.open(sessionId, termId, {
            onData: (base64Chunk) => {
              send(socket, { t: 'data', sessionId, termId, dataBase64: base64Chunk })
            },
            onExit: (exitCode) => {
              send(socket, { t: 'exit', sessionId, termId, exitCode })
            },
          }, { cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined, cols: 80, rows: 24 })
          if ('error' in result) {
            send(socket, { t: 'error', sessionId, termId, code: result.error, message: result.message })
            return
          }
          registry.cancelGrace(sessionId, termId)
          send(socket, {
            t: 'attached', sessionId, termId,
            pid: result.pid, shell: result.shell, replayBase64: result.replayBase64,
          })
          return
        }
        case 'input':
          if (!registry.input(sessionId, termId, String((parsed as { data?: unknown }).data ?? ''))) {
            send(socket, { t: 'error', sessionId, termId, code: 'not-attached', message: 'no live terminal for this id' })
          }
          return
        case 'resize': {
          const cols = Number((parsed as { cols?: unknown }).cols)
          const rows = Number((parsed as { rows?: unknown }).rows)
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
            send(socket, { t: 'error', sessionId, termId, code: 'bad-frame', message: 'resize needs numeric cols/rows' })
            return
          }
          registry.resize(sessionId, termId, cols, rows)
          return
        }
        case 'close':
          registry.close(sessionId, termId)
          return
        default:
          send(socket, { t: 'error', sessionId, termId, code: 'bad-frame', message: 'unknown message type' })
      }
    },
  }
}

/** Attach the terminal route to an upgraded socket. */
export function acceptTerminalSocket(
  registry: PtyRegistry,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { detachOnClose?: boolean } = {},
): void {
  const wss = new WebSocketServer({ noServer: true })
  wss.handleUpgrade(req, socket, head, (ws) => {
    const messenger = createTerminalMessenger(registry)
    ws.on('message', (raw) => {
      void messenger.handle(ws, raw)
    })
    if (options.detachOnClose !== false) {
      ws.on('close', () => {
        // Every terminal this socket opened enters its reconnect grace
        // period; the registry kills it when the countdown lapses without
        // a reattach.
        registry.detachAll()
      })
    }
  })
}

/**
 * Wire vocabulary shared by the host and client halves of the workbench.
 * Framework-free: importable from Node routes, browser code, and tests alike.
 */

/** Plugin id as declared in dsh.plugin.json. */
export const WORKBENCH_PLUGIN_ID = 'zdsh/workbench'

/** npm package name; the cordis loader mounts rows by this name. */
export const WORKBENCH_PACKAGE_NAME = 'zdsh-workbench'

/** Every HTTP route and WebSocket upgrade this plugin owns lives under it. */
export const WORKBENCH_ROUTE_PREFIX = '/workbench'

/**
 * Plugin version. MUST equal package.json "version" and dsh.plugin.json
 * "version"; tests/manifest.spec.ts guards the three-way sync.
 */
export const WORKBENCH_VERSION = '0.1.0-alpha.0'

/** Answer shape of GET/POST `/workbench/api/ping` — the liveness probe used by mount e2e. */
export interface PingResult {
  ok: true
  plugin: typeof WORKBENCH_PACKAGE_NAME
  version: string
}

export function pingResult(): PingResult {
  return { ok: true, plugin: WORKBENCH_PACKAGE_NAME, version: WORKBENCH_VERSION }
}

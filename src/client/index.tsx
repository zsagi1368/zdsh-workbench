/**
 * Workbench client half entry. Provides the panel/command registry as a
 * cordis service so any other browser plugin can `inject: ['workbench']` and
 * extend the shell through the same api the built-ins use, then mounts the
 * dock (self-attached React root; no host layout slot dependency).
 */
import type { Context } from '@deepseek-ai/cordis'
import { WORKBENCH_VERSION } from '../shared/protocol.ts'
import type { WorkbenchRegistryApi } from './registry.ts'
import { createWorkbenchRegistry } from './registry.ts'
import { setCollapsed, togglePalette } from './shell/events.ts'
import { mountDock } from './shell/mount.tsx'

export { createWorkbenchRegistry } from './registry.ts'
export type { CommandDescriptor, PanelDescriptor, RegisteredPanel, WorkbenchRegistryApi } from './registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workbench: WorkbenchRegistryApi
  }
}

/** Built-ins register through the same public api third parties use. */
function wireBuiltInCommands(registry: WorkbenchRegistryApi): () => void {
  const disposers = [
    registry.registerCommand({ id: 'workbench:palette', title: '工作台：打开命令面板', run: togglePalette }),
    registry.registerCommand({ id: 'workbench:collapse', title: '工作台：折叠侧栏', run: () => setCollapsed(true) }),
    registry.registerCommand({ id: 'workbench:expand', title: '工作台：展开侧栏', run: () => setCollapsed(false) }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export function apply(ctx: Context): void {
  const registry = createWorkbenchRegistry(WORKBENCH_VERSION)
  ctx.provide('workbench', registry)

  const disposeCommands = wireBuiltInCommands(registry)

  if (typeof document === 'undefined') {
    // Node/test or non-DOM surface: the service contract still loads.
    ctx.effect(() => disposeCommands)
    return
  }

  const dock = mountDock(registry)
  ctx.effect(() => () => {
    dock.dispose()
    disposeCommands()
  }, 'workbench: dock mount')
}

/**
 * Workbench client half entry. Provides the panel registry as a cordis
 * service so any other browser plugin can `inject: ['workbench']` and
 * register panels/viewers with the same api the built-in features use.
 * The dock shell that renders these registrations lands in M1 proper;
 * this entry exists so the service contract is load-bearing from day one.
 */
import type { Context } from '@deepseek-ai/cordis'
import { WORKBENCH_VERSION } from '../shared/protocol.ts'
import type { WorkbenchRegistryApi } from './registry.ts'
import { createWorkbenchRegistry } from './registry.ts'

export { createWorkbenchRegistry } from './registry.ts'
export type { PanelDescriptor, RegisteredPanel, WorkbenchRegistryApi } from './registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workbench: WorkbenchRegistryApi
  }
}

export function apply(ctx: Context): void {
  ctx.provide('workbench', createWorkbenchRegistry(WORKBENCH_VERSION))
}

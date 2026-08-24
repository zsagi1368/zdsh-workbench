/**
 * Workbench panel registry, the client-half extension surface. Pure data:
 * no React, no DOM, no cordis — so tests and future hosts can drive it
 * directly. Everything the workbench ships (and everything third-party code
 * registers) goes through THIS api; the shell renders only what is here.
 *
 * Lifecycle contract: registerX returns a disposer. Callers must wrap
 * registration in their fiber/effect lifecycle so disposers run on unload;
 * registering a duplicate id throws loudly instead of silently shadowing.
 */

/** A page that can be opened inside the dock or bottom panel. */
export interface PanelDescriptor {
  /** Globally unique id; convention `provider:panel`. */
  id: string
  /** Display title; i18n-aware callers pass a resolved string per locale change. */
  title: string
  /** `+` menu ordering, ascending; lower comes first. Default 100. */
  order?: number
}

export interface RegisteredPanel extends PanelDescriptor {
  readonly order: number
}

/** The registry face other modules receive via injection. */
export interface WorkbenchRegistryApi {
  /** Register a panel type; returns its disposer. Duplicate ids throw. */
  registerPanel(descriptor: PanelDescriptor): () => void
  /** Current registration snapshot, ordered by `order` then registration sequence. */
  getPanels(): readonly RegisteredPanel[]
  /** Subscribe to registration changes; returns an unsubscribe disposer. */
  subscribe(listener: () => void): () => void
  /** Plugin version this registry serves; consumers gate new api on it. */
  readonly version: string
  /**
   * Monotonic capability vocabulary (`only ever grows`). Consumers check
   * membership instead of comparing versions so old hosts degrade cleanly.
   */
  readonly features: readonly string[]
}

const REGISTRY_FEATURES: readonly string[] = ['panels'] as const

class RegistrationError extends Error {
  constructor(id: string) {
    super(`workbench: duplicate panel id "${id}"`)
    this.name = 'RegistrationError'
  }
}

export function createWorkbenchRegistry(version: string): WorkbenchRegistryApi {
  const panels = new Map<string, { descriptor: RegisteredPanel; seq: number }>()
  const listeners = new Set<() => void>()
  let nextSeq = 0

  const announce = (): void => {
    for (const listener of listeners) listener()
  }

  return {
    version,
    features: REGISTRY_FEATURES,
    registerPanel(descriptor) {
      if (panels.has(descriptor.id)) throw new RegistrationError(descriptor.id)
      const registered: RegisteredPanel = { ...descriptor, order: descriptor.order ?? 100 }
      const seq = nextSeq++
      panels.set(registered.id, { descriptor: registered, seq })
      announce()
      return () => {
        // Disposing an already-disposed registration stays a no-op so
        // double teardown (manual + fiber) never throws.
        if (!panels.has(registered.id)) return
        panels.delete(registered.id)
        announce()
      }
    },
    getPanels() {
      return [...panels.values()]
        .sort((a, b) => a.descriptor.order - b.descriptor.order || a.seq - b.seq)
        .map((entry) => entry.descriptor)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

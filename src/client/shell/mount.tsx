/**
 * DOM attachment for the dock shell. Self-mounting keeps the plugin
 * independent of any host-specific layout slot: it works identically on the
 * fork and on stock DSH, and teardown removes every node it created.
 */
import { createRoot } from 'react-dom/client'
import type { WorkbenchRegistryApi } from '../registry.ts'
import { DockRoot } from './DockRoot.tsx'
import { PALETTE_TOGGLE_EVENT } from './events.ts'
import { LayoutStore } from './layout-store.ts'
import { DOCK_CONTAINER_ID, WORKBENCH_STYLE_ID, WORKBENCH_STYLES } from './styles.ts'

export interface MountedDock {
  store: LayoutStore
  dispose(): void
}

/** Global hotkey (Ctrl/Cmd+Shift+P) → palette toggle event on window. */
function attachPaletteHotkey(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
      // The browser's own print dialog owns plain Ctrl+P; ours requires Shift.
      event.preventDefault()
      window.dispatchEvent(new Event(PALETTE_TOGGLE_EVENT))
    }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
  }
}

export function mountDock(registry: WorkbenchRegistryApi): MountedDock {
  const disposers: Array<() => void> = []

  let style = document.getElementById(WORKBENCH_STYLE_ID)
  if (style === null) {
    style = document.createElement('style')
    style.id = WORKBENCH_STYLE_ID
    style.textContent = WORKBENCH_STYLES
    document.head.appendChild(style)
    disposers.push(() => style?.remove())
  }

  const container = document.createElement('div')
  container.id = DOCK_CONTAINER_ID
  document.body.appendChild(container)
  disposers.push(() => container.remove())

  disposers.push(attachPaletteHotkey())

  const store = new LayoutStore('global', window.localStorage)
  const root = createRoot(container)
  root.render(<DockRoot registry={registry} store={store} />)

  return {
    store,
    dispose() {
      // React unmount must precede container removal so effects tear down.
      root.unmount()
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Teardown of one attachment must never block the rest.
        }
      }
    },
  }
}

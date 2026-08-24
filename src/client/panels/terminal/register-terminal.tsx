/**
 * The terminal feature: one panel hosting a persistent terminal keyed to
 * this page session. Reconnect semantics live in TerminalView; this module
 * only registers through the public registry api.
 */
import { useState } from 'react'
import type { WorkbenchRegistryApi } from '../../registry.ts'
import { TerminalView } from './TerminalView.tsx'

export function registerTerminalFeature(registry: WorkbenchRegistryApi): () => void {
  return registry.registerPanel({
    id: 'term:main',
    title: '终端',
    order: 40,
    component: function TerminalPanel() {
      const [nonce, setNonce] = useState(0)
      // The remount nonce is the "restart" affordance after an exit; the
      // view's own 重新启动 button flips phase, this one rebuilds from zero.
      void setNonce
      const root = readExplorerRoot()
      return <TerminalView key={nonce} termId={`main-${nonce}`} cwd={root ?? undefined} />
    },
  })
}

function readExplorerRoot(): string | null {
  try {
    const value = window.localStorage.getItem('zdsh.workbench.explorer.root')
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

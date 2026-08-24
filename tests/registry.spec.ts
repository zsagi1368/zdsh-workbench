import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchRegistry } from '../src/client/registry.ts'
import { WORKBENCH_VERSION } from '../src/shared/protocol.ts'

describe('workbench registry', () => {
  it('registers panels and returns them ordered by order then sequence', () => {
    const registry = createWorkbenchRegistry(WORKBENCH_VERSION)
    registry.registerPanel({ id: 'late:z', title: 'Z', order: 10 })
    registry.registerPanel({ id: 'default:a', title: 'A' })
    registry.registerPanel({ id: 'early:b', title: 'B', order: 5 })
    expect(registry.getPanels().map((p) => p.id)).toEqual(['early:b', 'late:z', 'default:a'])
    expect(registry.getPanels()[0]?.order).toBe(5)
    expect(registry.getPanels()[1]?.order).toBe(10)
  })

  it('applies the default order of 100', () => {
    const registry = createWorkbenchRegistry(WORKBENCH_VERSION)
    registry.registerPanel({ id: 'x:one', title: 'One' })
    expect(registry.getPanels()[0]?.order).toBe(100)
  })

  it('throws on duplicate ids and keeps the first registration intact', () => {
    const registry = createWorkbenchRegistry(WORKBENCH_VERSION)
    registry.registerPanel({ id: 'dup:key', title: 'First' })
    expect(() => registry.registerPanel({ id: 'dup:key', title: 'Second' })).toThrowError(/duplicate panel id "dup:key"/)
    expect(registry.getPanels()).toHaveLength(1)
    expect(registry.getPanels()[0]?.title).toBe('First')
  })

  it('disposal removes the panel and notifies subscribers exactly once per change', () => {
    const registry = createWorkbenchRegistry(WORKBENCH_VERSION)
    const listener = vi.fn()
    registry.subscribe(listener)
    const dispose = registry.registerPanel({ id: 'gone:panel', title: 'Gone' })
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(registry.getPanels()).toHaveLength(0)
  })

  it('double disposal stays a no-op without extra notifications', () => {
    const registry = createWorkbenchRegistry(WORKBENCH_VERSION)
    const listener = vi.fn()
    registry.subscribe(listener)
    const dispose = registry.registerPanel({ id: 'twice:panel', title: 'Twice' })
    dispose()
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe stops notifications', () => {
    const registry = createWorkbenchRegistry(WORKBENCH_VERSION)
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    unsubscribe()
    registry.registerPanel({ id: 'silent:panel', title: 'Silent' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('exposes its version and monotonic feature vocabulary', () => {
    const registry = createWorkbenchRegistry(WORKBENCH_VERSION)
    expect(registry.version).toBe(WORKBENCH_VERSION)
    expect(registry.features).toContain('panels')
  })
})

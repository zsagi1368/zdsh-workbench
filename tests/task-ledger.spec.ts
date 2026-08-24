import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TaskLedger } from '../src/host/task-ledger.ts'

async function tempLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-tasks-'))
  return join(dir, 'tasks.json')
}

describe('task ledger', () => {
  it('creates, updates and deletes with a monotonic revision', async () => {
    const ledger = new TaskLedger({ filePath: await tempLedgerPath() })
    await ledger.init()
    expect(ledger.getSnapshot().revision).toBe(1) // fresh persist bumps to 1

    const created = await ledger.create({ title: '写规划' })
    expect(created.ok).toBe(true)
    const id = (created.value?.tasks[0]?.id) ?? ''
    expect(created.value?.revision).toBe(2)

    const moved = await ledger.update({ id, status: 'doing' })
    expect(moved.value?.tasks[0]?.status).toBe('doing')
    expect(moved.value?.revision).toBeGreaterThan(created.value?.revision ?? 0)

    const renamed = await ledger.update({ id, title: '写完规划' })
    expect(renamed.value?.tasks[0]?.title).toBe('写完规划')

    const removed = await ledger.remove({ id })
    expect(removed.value?.tasks).toHaveLength(0)
  })

  it('rejects empty titles, bad statuses and unknown ids', async () => {
    const ledger = new TaskLedger({ filePath: await tempLedgerPath() })
    await ledger.init()
    expect((await ledger.create({ title: '   ' })).ok).toBe(false)
    expect((await ledger.update({ id: 'nope', status: 'doing' })).error?.code).toBe('not-found')
    const created = await ledger.create({ title: 'x' })
    const id = created.value?.tasks[0]?.id ?? ''
    expect((await ledger.update({ id, status: 'archived' })).error?.code).toBe('bad-request')
  })

  it('round-trips through the backing document', async () => {
    const path = await tempLedgerPath()
    const first = new TaskLedger({ filePath: path })
    await first.init()
    await first.create({ title: '持久化任务', status: 'doing' })

    const second = new TaskLedger({ filePath: path })
    await second.init()
    expect(second.getSnapshot().tasks).toHaveLength(1)
    expect(second.getSnapshot().tasks[0]?.title).toBe('持久化任务')
    expect(second.getSnapshot().tasks[0]?.status).toBe('doing')
  })

  it('quarantines a corrupt document instead of failing boot', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'wb-tasks-')), 'nested')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'tasks.json')
    await writeFile(path, '{{{ not json')

    const listener = vi.fn()
    const ledger = new TaskLedger({ filePath: path })
    ledger.subscribe(listener)
    await ledger.init()

    // Fresh start after quarantine.
    expect(ledger.getSnapshot().tasks).toHaveLength(0)
    const files = await readdir(dir)
    expect(files.some((name) => name.includes('.corrupt-'))).toBe(true)
    void listener
  })

  it('keeps raw bytes readable for inspection in the quarantined copy', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'wb-tasks-')), 'n')
    const { mkdir, writeFile, readdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'tasks.json')
    await writeFile(path, 'broken-bytes')
    const ledger = new TaskLedger({ filePath: path })
    await ledger.init()
    const files = await readdir(dir)
    const kept = files.find((name) => name.includes('.corrupt-')) ?? ''
    expect((await readFile(join(dir, kept), 'utf8'))).toBe('broken-bytes')
  })

  it('notifies subscribers with the new revision after each commit', async () => {
    const ledger = new TaskLedger({ filePath: await tempLedgerPath() })
    await ledger.init()
    const seen: number[] = []
    ledger.subscribe((frame) => {
      if (frame.domain === 'tasks') seen.push(frame.revision)
    })
    const created = await ledger.create({ title: 'a' })
    const id = created.ok ? (created.value.tasks[0]?.id ?? '') : ''
    await ledger.update({ id, status: 'done' })
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.at(-1)).toBe(ledger.getSnapshot().revision)
  })
})

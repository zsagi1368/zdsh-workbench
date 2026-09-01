import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskLedger } from '../src/task-ledger.ts'

async function tempLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-tasks-'))
  return join(dir, 'tasks.json')
}

describe('task ledger', () => {
  /** Narrow the envelope loudly: fail the test when a success was expected to fail. */
  function errOf(envelope: { ok: boolean; error?: { code: string } }): string {
    if (envelope.ok || envelope.error === undefined) throw new Error('expected an envelope failure')
    return envelope.error.code
  }

  it('creates, updates and deletes with a monotonic revision', async () => {
    const ledger = new TaskLedger({ filePath: await tempLedgerPath() })
    await ledger.init()
    expect(ledger.getSnapshot().revision).toBe(0) // fresh start, no commits yet

    const created = await ledger.create({ title: '写规划' })
    expect(created.ok).toBe(true)
    const firstTask = created.ok ? created.value.tasks[0] : undefined
    const id = firstTask?.id ?? ''
    expect(created.ok ? created.value.revision : -1).toBe(1) // one committed mutation

    const moved = await ledger.update({ id, status: 'doing' })
    expect(moved.ok ? moved.value.tasks[0]?.status : '').toBe('doing')
    expect(moved.ok ? moved.value.revision : -1).toBeGreaterThan(created.ok ? created.value.revision : 0)

    const renamed = await ledger.update({ id, title: '写完规划' })
    expect(renamed.ok ? renamed.value.tasks[0]?.title : '').toBe('写完规划')

    const removed = await ledger.remove({ id })
    expect(removed.ok ? removed.value.tasks.length : -1).toBe(0)
  })

  it('rejects empty titles, bad statuses and unknown ids', async () => {
    const ledger = new TaskLedger({ filePath: await tempLedgerPath() })
    await ledger.init()
    expect(errOf(await ledger.create({ title: '   ' }))).toBe('bad-request')
    expect(errOf(await ledger.update({ id: 'nope', status: 'doing' }))).toBe('not-found')
    const created = await ledger.create({ title: 'x' })
    const id = created.ok ? (created.value.tasks[0]?.id ?? '') : ''
    expect(errOf(await ledger.update({ id, status: 'archived' }))).toBe('bad-request')
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

  describe('defaultFilePath derivation chain (stubbed process.env)', () => {
    const savedEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
      for (const key of ['DSH_BRANCH_HOME', 'DSH_HOME', 'HOME', 'UserProfile'] as const) {
        savedEnv[key] = process.env[key]
        delete process.env[key]
      }
    })

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })

    /** No-arg construction exercises the private defaultFilePath; one mutation forces a write. */
    async function assertDerivedPath(env: Record<string, string | undefined>, expected: string): Promise<void> {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      const ledger = new TaskLedger()
      await ledger.init()
      const created = await ledger.create({ title: '派生链探针' })
      expect(created.ok).toBe(true)
      await expect(stat(expected)).resolves.toBeTruthy()
      expect((await readFile(expected, 'utf8')).includes('派生链探针')).toBe(true)
    }

    it('routes to <DSH_BRANCH_HOME>/workbench/tasks.json when DSH_BRANCH_HOME is set', async () => {
      const root = await mkdtemp(join(tmpdir(), 'wb-branch-'))
      await assertDerivedPath(
        { DSH_BRANCH_HOME: root, DSH_HOME: join(root, 'unused'), HOME: undefined, UserProfile: undefined },
        join(root, 'workbench', 'tasks.json'),
      )
    })

    it('derives <DSH_HOME>/zdsh/workbench/tasks.json when only DSH_HOME is set', async () => {
      const root = await mkdtemp(join(tmpdir(), 'wb-home-'))
      await assertDerivedPath(
        { DSH_BRANCH_HOME: undefined, DSH_HOME: root, HOME: undefined, UserProfile: undefined },
        join(root, 'zdsh', 'workbench', 'tasks.json'),
      )
    })

    it('falls back to the legacy ~/.zdsh-workbench/tasks.json when both are unset', async () => {
      const home = await mkdtemp(join(tmpdir(), 'wb-legacy-'))
      await assertDerivedPath(
        { DSH_BRANCH_HOME: undefined, DSH_HOME: undefined, HOME: home, UserProfile: undefined },
        join(home, '.zdsh-workbench', 'tasks.json'),
      )
    })

    it('skips blank DSH_BRANCH_HOME / DSH_HOME values to the next tier', async () => {
      const home = await mkdtemp(join(tmpdir(), 'wb-blank-'))
      const root = await mkdtemp(join(tmpdir(), 'wb-blank-root-'))
      await assertDerivedPath(
        {
          DSH_BRANCH_HOME: '   ',
          DSH_HOME: root,
          HOME: home,
          UserProfile: undefined,
        },
        join(root, 'zdsh', 'workbench', 'tasks.json'),
      )
    })
  })
})

/**
 * SMI-6531 (A1 step 7a): T-C2, the manifest CAS in the swap, on a real
 * manifest file through `createManifestPort` and `swapInPlace`.
 *
 * Case A: `ManifestManager.updateSafely` changes `pinnedVersion` after the
 * swap, in `hooks.beforeCommit`; the commit's CAS must catch it and undo.
 * Case B: the same change before the swap, in `hooks.afterBuild`; step 4's CAS
 * must refuse before any rename (the core-side counterpart of T-C1, since the
 * real `runMarkLocal` is mcp-only).
 *
 * Every absence (no rename, no record) is read from a run beside a control run
 * on the same fixture that does rename and does write a record.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ManifestPort } from '../../../src/services/skill-swap.js'
import { createManifestPort } from '../../../src/services/skill-manifest.port.js'
import { ManifestManager } from '../../../src/services/skill-manifest.js'
import type { SkillManifest } from '../../../src/services/skill-installation.types.js'
import type { TraceOp } from '../../../src/services/skill-swap.js'
import {
  areaOf,
  hashOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture, Planned } from './skill-swap.helpers.js'

useTmpCleanup()

const PRE = {
  id: 'a/my-skill',
  name: 'my-skill',
  version: '1.0.0',
  source: 'github:a/my-skill',
  installPath: '/x',
  installedAt: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-01T00:00:00.000Z',
}
const POST = { ...PRE, version: '2.0.0', lastUpdated: '2026-10-25T00:00:00.000Z' }

/** A plan whose input runs through the real port over a real manifest file. */
function realPlan(fx: Fixture): Planned & { manifestPath: string } {
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const { manifestPath } = p.input
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ version: '1.0.0', installedSkills: { [fx.dirName]: PRE } }, null, 2)
  )
  const target = { manifestPath, manifestKey: fx.dirName, preEntry: PRE, postEntry: POST }
  p.input = { ...p.input, preEntry: PRE, postEntry: POST, manifest: createManifestPort(target) }
  return Object.assign(p, { manifestPath })
}

const entryOf = (manifestPath: string, key: string): Record<string, unknown> =>
  (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SkillManifest).installedSkills[
    key
  ] as unknown as Record<string, unknown>

/** What a concurrent `mark_local`-style writer does: pin the entry through the locked update. */
const pinEntry = (manifestPath: string, key: string) => async () => {
  await new ManifestManager(manifestPath).updateSafely((m) => ({
    ...m,
    installedSkills: {
      ...m.installedSkills,
      [key]: { ...(m.installedSkills[key] as object), pinnedVersion: 'abcd1234' } as never,
    },
  }))
}

const renames = (trace: TraceOp[]) => trace.filter((t) => t.op === 'rename')
const recordLinks = (trace: TraceOp[]) =>
  trace.filter((t) => t.op === 'link' && t.dest.endsWith('record.json'))

describe('T-C2 case A: the entry changes after the swap, before the commit', () => {
  it('the commit CAS catches it: undone, the old folder back, the new tree kept, the new pin kept', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = realPlan(fx)
    const { result, trace } = await run(p, {
      hooks: { beforeCommit: pinEntry(p.manifestPath, fx.dirName) },
    })
    expect(result).toMatchObject({
      status: 'undone',
      reason: 'changed-since-plan',
      keptAs: 'undone',
    })
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v1\n')
    const kept = path.join(areaOf(fx), `${OP_ID}.undone`)
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toBe('# v2\n')
    // The manifest keeps the other writer's pin and was not moved to POST.
    expect(entryOf(p.manifestPath, fx.dirName)).toEqual({ ...PRE, pinnedVersion: 'abcd1234' })
    expect(trace.some((t) => t.op === 'manifest-write')).toBe(false)
  })

  it('the control, without the change, commits and writes POST', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = realPlan(fx)
    const { result, trace } = await run(p)
    expect(result.status).toBe('committed')
    expect(entryOf(p.manifestPath, fx.dirName)).toEqual(POST)
    expect(trace.some((t) => t.op === 'manifest-write')).toBe(true)
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v2\n')
  })
})

describe('T-C2 case B: the entry changes before the swap, in afterBuild', () => {
  it('step 4 refuses changed-since-plan before any rename and before any record', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = realPlan(fx)
    const { result, trace } = await run(p, {
      hooks: { afterBuild: pinEntry(p.manifestPath, fx.dirName) },
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'changed-since-plan' })
    expect(renames(trace)).toEqual([])
    expect(recordLinks(trace)).toEqual([])
    expect(fs.existsSync(path.join(fx.opDir, 'record.json'))).toBe(false)
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
    expect(entryOf(p.manifestPath, fx.dirName)).toEqual({ ...PRE, pinnedVersion: 'abcd1234' })
  })

  it('the control, on the same fixture without the change, does rename and does link a record', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = realPlan(fx)
    const { result, trace } = await run(p)
    expect(result.status).toBe('committed')
    expect(renames(trace).length).toBeGreaterThanOrEqual(2)
    expect(recordLinks(trace).length).toBeGreaterThanOrEqual(1)
  })
})

/** The real port, but each lock-3 attempt first ages the lock past 25 s while `lose(attempt)` says so. */
function losingPort(p: ReturnType<typeof realPlan>, lose: (attempt: number) => boolean) {
  const real = p.input.manifest
  let attempts = 0
  const port: ManifestPort = {
    withManifestLock: (fn) =>
      real.withManifestLock(async (m) => {
        attempts += 1
        if (lose(attempts)) {
          const t = Date.now() / 1000 - 26
          fs.utimesSync(`${p.manifestPath}.lock`, t, t)
        }
        return fn(m)
      }),
  }
  return { port, attempts: () => attempts }
}

describe('the commit retry after a lost manifest lock', () => {
  const liveEdit = (fx: Fixture) => () => {
    fs.appendFileSync(path.join(fx.realDir, 'a.txt'), 'live\n')
  }

  it('retries only the lock-3 part: the hook and the live-folder warning happen once, and the retry commits', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n', 'a.txt': 'a\n' })
    const p = realPlan(fx)
    const lost = losingPort(p, (n) => n === 2)
    p.input = { ...p.input, manifest: lost.port }
    let rehashHooks = 0
    const { result, trace } = await run(p, {
      hooks: {
        beforeCommitRehash: () => {
          rehashHooks += 1
          liveEdit(fx)()
        },
      },
    })
    // Attempt 1 is step 4's CAS hold; 2 is the commit's first hold, which loses; 3 is its retry.
    expect(lost.attempts()).toBe(3)
    expect(result.status).toBe('committed')
    expect(rehashHooks).toBe(1)
    expect(result.warnings.filter((w) => w.code === 'live-folder-changed')).toEqual([
      { code: 'live-folder-changed', paths: ['a.txt'] },
    ])
    expect(trace.filter((t) => t.op === 'manifest-write')).toHaveLength(1)
    expect(entryOf(p.manifestPath, fx.dirName)).toEqual(POST)
  })

  it('a second loss stops with pre-commit-check-failed, the record kept and the manifest unwritten', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n', 'a.txt': 'a\n' })
    const p = realPlan(fx)
    const lost = losingPort(p, (n) => n >= 2)
    p.input = { ...p.input, manifest: lost.port }
    let rehashHooks = 0
    const { result, trace } = await run(p, {
      hooks: {
        beforeCommitRehash: () => {
          rehashHooks += 1
        },
      },
    })
    expect(lost.attempts()).toBe(3)
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'pre-commit-check-failed',
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    expect(rehashHooks).toBe(1)
    expect(trace.some((t) => t.op === 'manifest-write')).toBe(false)
    expect(entryOf(p.manifestPath, fx.dirName)).toEqual(PRE)
  })
})

/** The real port, but `onHold(attempt)` runs inside each lock-3 hold just before the callback. */
function hookedPort(p: ReturnType<typeof realPlan>, onHold: (attempt: number) => void) {
  const real = p.input.manifest
  let attempts = 0
  const port: ManifestPort = {
    withManifestLock: (fn) =>
      real.withManifestLock(async (m) => {
        attempts += 1
        onHold(attempts)
        return fn(m)
      }),
  }
  return port
}

describe('commit(): write() throws ManifestEntryChanged after casMatches() was true', () => {
  it('undoes with changed-since-plan, writes nothing, and restores the old folder', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = realPlan(fx)
    const real = p.input.manifest
    const pinned = { ...PRE, pinnedVersion: 'z' }
    const changed = { version: '1.0.0', installedSkills: { [fx.dirName]: pinned } }
    const casAnswers: boolean[] = []
    let holds = 0
    p.input = {
      ...p.input,
      manifest: {
        withManifestLock: (fn) =>
          real.withManifestLock(async (m) => {
            holds += 1
            if (holds < 2) return fn(m)
            // The commit's hold: the CAS answers true, then the entry changes before write().
            return fn({
              ...m,
              casMatches: async () => {
                const r = await m.casMatches()
                casAnswers.push(r)
                fs.writeFileSync(p.manifestPath, JSON.stringify(changed))
                return r
              },
            })
          }),
      },
    }
    const { result, trace } = await run(p)
    expect(casAnswers).toEqual([true])
    expect(result).toMatchObject({ status: 'undone', reason: 'changed-since-plan' })
    expect(trace.some((t) => t.op === 'manifest-write')).toBe(false)
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
    expect(entryOf(p.manifestPath, fx.dirName)).toEqual(pinned)
  })

  it('the control, with the entry untouched, commits', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = realPlan(fx)
    const { result, trace } = await run(p)
    expect(result.status).toBe('committed')
    expect(trace.some((t) => t.op === 'manifest-write')).toBe(true)
  })
})

describe('an undo drops the live-folder-changed warning', () => {
  const edit = (fx: Fixture) => () => {
    fs.appendFileSync(path.join(fx.realDir, 'a.txt'), 'live\n')
  }

  it('a live edit plus a CAS failure: undone, no such warning, the edit kept under keptPath', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n', 'a.txt': 'a\n' })
    const p = realPlan(fx)
    const { result } = await run(p, {
      hooks: {
        beforeCommit: pinEntry(p.manifestPath, fx.dirName),
        beforeCommitRehash: edit(fx),
      },
    })
    expect(result.status).toBe('undone')
    if (result.status !== 'undone') throw new Error('unreachable')
    expect(result.warnings.some((w) => w.code === 'live-folder-changed')).toBe(false)
    expect(fs.readFileSync(path.join(result.keptPath!, 'a.txt'), 'utf8')).toContain('live')
  })

  it('the control, the same edit without the CAS failure, commits and does warn', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n', 'a.txt': 'a\n' })
    const p = realPlan(fx)
    const { result } = await run(p, { hooks: { beforeCommitRehash: edit(fx) } })
    expect(result.status).toBe('committed')
    expect(result.warnings.some((w) => w.code === 'live-folder-changed')).toBe(true)
  })
})

describe('commit(): the in-hold identity check', () => {
  it('a folder replaced just before the callback runs stops with target-changed, writing nothing', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = realPlan(fx)
    p.input = {
      ...p.input,
      manifest: hookedPort(p, (n) => {
        if (n !== 2) return
        fs.renameSync(fx.realDir, `${fx.realDir}.moved`)
        fs.mkdirSync(fx.realDir)
      }),
    }
    const { result, trace } = await run(p)
    expect(result).toMatchObject({ status: 'stopped', reason: 'target-changed' })
    expect(trace.some((t) => t.op === 'manifest-write')).toBe(false)
    expect(entryOf(p.manifestPath, fx.dirName)).toEqual(PRE)
  })

  it('the control, nothing replaced, commits through the same wrapper', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = realPlan(fx)
    p.input = { ...p.input, manifest: hookedPort(p, () => undefined) }
    const { result } = await run(p)
    expect(result.status).toBe('committed')
  })
})

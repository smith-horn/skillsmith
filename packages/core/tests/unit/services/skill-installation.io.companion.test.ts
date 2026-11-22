/**
 * SMI-6531 (A1 step 8-i-a-3a, governance findings 2, 3 and 6): the staged
 * rollback (`performRollback` on a `newWriteTracker(N)`) driven directly, so
 * each of its own guards is observed alone rather than behind another one:
 *  - the folder-removal guard, with the tracker saying this call created N
 *    and bound its real (dev, ino), so `removeCreatedDirectory`'s identity
 *    check would let a removal through;
 *  - a staged file with no full identity is never unlinked by path;
 *  - a bound identity whose birthtime differs is not the same file.
 * Every rename and removal through either specifier of `fs/promises` is
 * recorded (pass-through).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: [] as Array<{ op: string; path: string }> }))
const recorder = async (actual: typeof import('fs/promises')) => {
  const wrap =
    <A extends unknown[], R>(op: string, f: (p: string, ...a: A) => Promise<R>) =>
    (p: string, ...a: A): Promise<R> => {
      calls.list.push({ op, path: String(p) })
      return f(p, ...a)
    }
  return {
    ...actual,
    rename: wrap('rename', actual.rename as (p: string, d: string) => Promise<void>),
    unlink: wrap('unlink', actual.unlink as (p: string) => Promise<void>),
    rmdir: wrap('rmdir', actual.rmdir as (p: string) => Promise<void>),
    rm: wrap('rm', actual.rm as (p: string) => Promise<void>),
  }
}
vi.mock('fs/promises', async (importOriginal) =>
  recorder(await importOriginal<typeof import('fs/promises')>())
)
vi.mock('node:fs/promises', async (importOriginal) =>
  recorder(await importOriginal<typeof import('fs/promises')>())
)

const { newWriteTracker, performRollback } =
  await import('../../../src/services/skill-installation.io.companion.js')
const { bindIdentity, sameIdentity } = await import('../../../src/install/park-tree.identity.js')

const bases: string[] = []
afterEach(() => {
  calls.list = []
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

/** N with two files and a sub-directory under a staging tree, and a companion file outside it. */
function layout() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'staged-rb-'))
  bases.push(base)
  const n = path.join(base, 'skills', '.skillsmith-staging', 'b'.repeat(32), 'new')
  fs.mkdirSync(path.join(n, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(n, 'SKILL.md'), '# skill\n')
  fs.writeFileSync(path.join(n, 'scripts', 'run.sh'), 'echo\n')
  const companion = path.join(base, 'agents', 'my-skill-specialist.md')
  fs.mkdirSync(path.dirname(companion))
  fs.writeFileSync(companion, '---\nname: my-skill\n---\n')
  return { base, n, companion }
}

const idsUnder = (dir: string): Array<[string, ReturnType<typeof bindIdentity>]> => {
  const out: Array<[string, ReturnType<typeof bindIdentity>]> = [[dir, bindIdentity(dir)]]
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...idsUnder(p))
    else out.push([p, bindIdentity(p)])
  }
  return out
}

const touches = (p: string, dir: string): boolean =>
  p === dir || p.startsWith(dir + path.sep) || dir.startsWith(p + path.sep)

describe('staged performRollback: the folder-removal guard alone', () => {
  it('a tracker that says this call created N (its real dev and ino): N and every entry keep their identity', async () => {
    const { n } = layout()
    const t = newWriteTracker(path.resolve(n))
    const st = fs.lstatSync(n)
    t.pathValidated = true
    t.preExisted = false
    t.installDirIdentity = { dev: st.dev, ino: st.ino }
    const before = idsUnder(n)
    const r = await performRollback(t, n, 'claude-code')
    // Presence and identity, every entry of N, N included.
    for (const [p, id] of before) {
      const now = bindIdentity(p)
      expect(id.ok && now.ok && sameIdentity(id, now), p).toBe(true)
    }
    // No rename or removal reached N, its entries or its parent chain.
    expect(calls.list.filter((c) => touches(c.path, n))).toEqual([])
    expect(r).toEqual({ restoreFailures: [], cleanupFailures: [] })
  })
})

describe('staged performRollback: the companion file', () => {
  it('created with no full identity: left in place and reported, never unlinked by path', async () => {
    const { n, companion } = layout()
    const t = newWriteTracker(path.resolve(n))
    const st = fs.lstatSync(companion)
    t.createdFresh.push({ path: companion, identity: { dev: st.dev, ino: st.ino } })
    const r = await performRollback(t, n, 'claude-code')
    expect(fs.existsSync(companion)).toBe(true)
    expect(calls.list.filter((c) => c.op === 'unlink')).toEqual([])
    expect(r.cleanupFailures).toEqual([
      `${companion} (its identity could not be bound when created; left in place)`,
    ])
  })

  it('a bound identity with the same dev and ino but another birthtime: not the same file, not unlinked', async () => {
    const { n, companion } = layout()
    const t = newWriteTracker(path.resolve(n))
    const id = bindIdentity(companion)
    if (!id.ok) throw new Error('no identity')
    const st = fs.lstatSync(companion)
    t.createdFresh.push({
      path: companion,
      identity: { dev: st.dev, ino: st.ino },
      bound: { ...id, birthtimeNs: id.birthtimeNs + 1n },
    })
    const r = await performRollback(t, n, 'claude-code')
    expect(fs.existsSync(companion)).toBe(true)
    expect(calls.list.filter((c) => c.op === 'unlink')).toEqual([])
    expect(r.cleanupFailures).toEqual([])
  })

  it('control: the bound identity as created: the companion is unlinked, N untouched', async () => {
    const { n, companion } = layout()
    const t = newWriteTracker(path.resolve(n))
    const id = bindIdentity(companion)
    if (!id.ok) throw new Error('no identity')
    const st = fs.lstatSync(companion)
    t.createdFresh.push({ path: companion, identity: { dev: st.dev, ino: st.ino }, bound: id })
    await performRollback(t, n, 'claude-code')
    expect(fs.existsSync(companion)).toBe(false)
    expect(calls.list).toEqual([{ op: 'unlink', path: companion }])
    expect(fs.existsSync(path.join(n, 'SKILL.md'))).toBe(true)
  })
})

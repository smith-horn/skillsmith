/**
 * SMI-6531 (A1 step 8-i-a-3a, design § 1.3): writeInstallFiles' opt-in staged
 * mode. The caller made the folder (the staged install's `OP/new`); the call
 * writes into it, creates nothing else but the companion file (D4), runs the
 * caller's check before every create, binds each created entry's full
 * identity, and its rollback (in-call or returned) never restores, unlinks or
 * removes anything under the folder. Removals are observed through a
 * pass-through wrapper on `fs/promises` (`unlink`, `rmdir`, `rm`), the only
 * removal family writeInstallFiles and its rollback use.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const removals = vi.hoisted(() => ({ calls: [] as Array<{ op: string; path: string }> }))
// One-shot: the next `open` of this path returns a handle whose `stat` fails
// (safeCreateFile's fstat), so the create reports no identity.
const statFails = vi.hoisted(() => ({ path: null as string | null }))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const wrap =
    <A extends unknown[], R>(op: string, f: (p: string, ...a: A) => Promise<R>) =>
    (p: string, ...a: A): Promise<R> => {
      removals.calls.push({ op, path: String(p) })
      return f(p, ...a)
    }
  const open = async (...a: Parameters<typeof actual.open>) => {
    const h = await actual.open(...a)
    if (statFails.path === null || String(a[0]) !== statFails.path) return h
    statFails.path = null
    return new Proxy(h, {
      get(target, key) {
        if (key === 'stat') {
          return () => Promise.reject(Object.assign(new Error('forced'), { code: 'EIO' }))
        }
        const v = Reflect.get(target, key, target) as unknown
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v
      },
    })
  }
  return {
    ...actual,
    open,
    unlink: wrap('unlink', actual.unlink as (p: string) => Promise<void>),
    rmdir: wrap('rmdir', actual.rmdir as (p: string) => Promise<void>),
    rm: wrap('rm', actual.rm as (p: string) => Promise<void>),
  }
})

const { writeInstallFiles } = await import('../../../src/services/skill-installation.io.write.js')
const { bindIdentity, sameIdentity } = await import('../../../src/install/park-tree.identity.js')
const { InstallRestoreError } =
  await import('../../../src/services/skill-installation.io.rollback.js')

const bases: string[] = []
afterEach(() => {
  removals.calls = []
  statFails.path = null
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

interface Layout {
  base: string
  skillsDir: string
  newDir: string
  companion: string
  agentDir: string
}

/** A skills root R with `R/.skillsmith-staging/<op>/new` made by "the caller", and a companion base. */
function layout(): Layout {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'staged-wif-'))
  bases.push(base)
  const skillsDir = path.join(base, 'skills')
  const newDir = path.join(skillsDir, '.skillsmith-staging', 'a'.repeat(32), 'new')
  fs.mkdirSync(newDir, { recursive: true })
  const agentDir = path.join(base, '.agents', 'agents', 'my-skill')
  return { base, skillsDir, newDir, companion: path.join(agentDir, 'agent.md'), agentDir }
}

/** Every path under `dir` (files and directories), sorted. */
function listUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    out.push(p)
    if (e.isDirectory()) out.push(...listUnder(p))
  }
  return out.sort()
}

const under = (dir: string, p: string): boolean => p === dir || p.startsWith(dir + path.sep)
const SUB = [{ filename: 'scripts/run.sh', content: 'echo hi\n' }]

/** One staged write; `check` is the caller's check, `sub` the sub-skill files. */
function write(
  l: Layout,
  check: () => void,
  o: { sub?: Array<{ filename: string; content: string }>; companion?: boolean } = {}
) {
  return writeInstallFiles(
    l.newDir,
    l.skillsDir,
    'my-skill',
    '# skill\n',
    o.sub ?? SUB,
    o.companion === false ? undefined : '---\nname: my-skill\n---\n',
    'antigravity',
    l.base,
    { staged: { dir: l.newDir, beforeCreate: check } }
  )
}

describe('writeInstallFiles staged mode: what it creates', () => {
  it('writes into the folder, creates nothing else but the companion, binds each create with its full identity', async () => {
    const l = layout()
    const rootBefore = fs.readdirSync(l.skillsDir).sort()
    let checks = 0
    const r = await write(l, () => checks++)
    // Presence: the files in N, the companion outside.
    expect(fs.readFileSync(path.join(l.newDir, 'SKILL.md'), 'utf8')).toBe('# skill\n')
    expect(fs.readFileSync(path.join(l.newDir, 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')
    expect(r.subagentPath).toBe(l.companion)
    expect(fs.existsSync(l.companion)).toBe(true)
    // Absence: nothing new in the skills root, and no folder at the skill path.
    expect(fs.readdirSync(l.skillsDir).sort()).toEqual(rootBefore)
    expect(fs.existsSync(path.join(l.skillsDir, 'my-skill'))).toBe(false)
    // Every entry under N, and the companion file, was reported with the identity it has now.
    const created = r.stagedCreated ?? []
    expect(created.map((c) => c.path).sort()).toEqual([...listUnder(l.newDir), l.companion].sort())
    for (const c of created) {
      const now = bindIdentity(c.path)
      expect(c.identity, c.path).not.toBeNull()
      expect(now.ok && c.identity !== null && sameIdentity(c.identity, now), c.path).toBe(true)
      expect(c.identity?.birthtimeNs, c.path).toBeTypeOf('bigint')
    }
    // One check per create: each file, each directory, and the companion's agents directory.
    expect(checks).toBe(created.length + 1)
    expect(removals.calls).toEqual([])
  })

  it('an existing companion file is never overwritten (the install is fresh)', async () => {
    const l = layout()
    fs.mkdirSync(l.agentDir, { recursive: true })
    fs.writeFileSync(l.companion, 'the user’s own\n')
    const before = bindIdentity(l.companion)
    const r = await write(l, () => {})
    expect(r.companionSkipped).toBe(true)
    expect(r.subagentPath).toBeUndefined()
    expect(fs.readFileSync(l.companion, 'utf8')).toBe('the user’s own\n')
    const now = bindIdentity(l.companion)
    expect(before.ok && now.ok && sameIdentity(before, now)).toBe(true)
    expect(fs.existsSync(path.join(l.newDir, 'SKILL.md'))).toBe(true)
  })

  it('refuses a folder that is not installPath, or not a directory, creating nothing', async () => {
    const l = layout()
    await expect(
      writeInstallFiles(
        l.newDir,
        l.skillsDir,
        'my-skill',
        '# s\n',
        [],
        undefined,
        'antigravity',
        l.base,
        {
          staged: { dir: path.join(l.skillsDir, 'elsewhere'), beforeCreate: () => {} },
        }
      )
    ).rejects.toThrow(TypeError)
    fs.rmdirSync(l.newDir)
    fs.writeFileSync(l.newDir, 'a file\n')
    await expect(write(l, () => {}, { companion: false })).rejects.toThrow('not a directory')
    expect(fs.readFileSync(l.newDir, 'utf8')).toBe('a file\n')
    expect(fs.existsSync(path.join(l.skillsDir, 'my-skill'))).toBe(false)
  })
})

describe('writeInstallFiles staged mode: the check before every create', () => {
  it('a check that refuses from its k-th call on: never more creates than passed checks; nothing under N removed', async () => {
    // The success run's check count is the number of creates plus the agents directory's.
    const total = await (async () => {
      const l = layout()
      let n = 0
      await write(l, () => n++)
      return n
    })()
    expect(total).toBeGreaterThan(3)
    removals.calls = []
    for (let k = 1; k <= total; k++) {
      const l = layout()
      let n = 0
      const err = await write(l, () => {
        n++
        if (n >= k) throw new Error(`refused at check ${n}`)
      }).catch((e: unknown) => e)
      expect(err, `k=${k}`).toBeInstanceOf(Error)
      const inN = listUnder(l.newDir)
      // Each create in N needed its own passing check, so at most k-1 exist.
      expect(inN.length, `k=${k}`).toBeLessThanOrEqual(k - 1)
      // The companion is rolled back (identity-checked) or never made; N's own entries all stay.
      expect(fs.existsSync(l.companion), `k=${k}`).toBe(false)
      expect(
        removals.calls.filter((c) => under(l.newDir, c.path)),
        `k=${k}`
      ).toEqual([])
      removals.calls = []
    }
  })
})

describe('writeInstallFiles staged mode: rollback never touches N', () => {
  it('the returned rollback unlinks only the companion (and rmdirs its agent dir); every entry in N stays', async () => {
    const l = layout()
    const r = await write(l, () => {})
    const inN = listUnder(l.newDir).map((p) => [p, bindIdentity(p)] as const)
    await r.rollback(new Error('a later step failed'))
    // Absence: the companion and the agent dir this call made.
    expect(fs.existsSync(l.companion)).toBe(false)
    expect(fs.existsSync(l.agentDir)).toBe(false)
    // Presence, same run: every entry under N, with its identity.
    for (const [p, id] of inN) {
      const now = bindIdentity(p)
      expect(id.ok && now.ok && sameIdentity(id, now), p).toBe(true)
    }
    expect(removals.calls).toEqual([
      { op: 'unlink', path: l.companion },
      { op: 'rmdir', path: l.agentDir },
    ])
  })

  it('a companion replaced by another file before the rollback is left in place', async () => {
    const l = layout()
    const r = await write(l, () => {})
    fs.renameSync(l.companion, path.join(l.base, 'moved.md'))
    fs.writeFileSync(l.companion, 'someone else’s\n')
    await r.rollback(new Error('later'))
    expect(fs.readFileSync(l.companion, 'utf8')).toBe('someone else’s\n')
    expect(removals.calls.filter((c) => c.op === 'unlink')).toEqual([])
    expect(fs.existsSync(path.join(l.newDir, 'SKILL.md'))).toBe(true)
  })

  it('a companion created with no identity (its fstat failed): the rollback leaves it and reports it', async () => {
    const l = layout()
    statFails.path = l.companion
    const r = await write(l, () => {})
    expect(statFails.path).toBeNull()
    const companionEntry = (r.stagedCreated ?? []).find((c) => c.path === l.companion)
    expect(companionEntry).toEqual({ path: l.companion, type: 'file', identity: null })
    const err = await r.rollback(new Error('later')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstallRestoreError)
    expect((err as InstanceType<typeof InstallRestoreError>).cleanupFailures).toEqual([
      `${l.companion} (its identity could not be bound when created; left in place)`,
    ])
    expect(fs.existsSync(l.companion)).toBe(true)
    expect(removals.calls.filter((c) => c.op === 'unlink')).toEqual([])
    expect(fs.existsSync(path.join(l.newDir, 'SKILL.md'))).toBe(true)
  })

  it('an in-call failure after SKILL.md was written: rejects, N keeps what was written, nothing under N removed', async () => {
    const l = layout()
    const err = await write(l, () => {}, {
      sub: [{ filename: '../../../../escape.md', content: 'x\n' }],
    }).catch((e: unknown) => e)
    expect(String(err)).toContain('escapes install directory')
    expect(fs.readFileSync(path.join(l.newDir, 'SKILL.md'), 'utf8')).toBe('# skill\n')
    expect(removals.calls.filter((c) => under(l.newDir, c.path))).toEqual([])
    expect(fs.existsSync(path.join(l.base, 'escape.md'))).toBe(false)
  })
})

/**
 * SMI-6531 (A1 step 6a-i): T-J12 (discovery), the leftover probes of T-X18 (e),
 * the read-only binding, and `doctor locks` over the discovered roots (plan
 * §3.9, UD22, UD25).
 *
 * Discovery reads three sources and creates nothing. The fixtures put a real
 * op dir in exactly one root at a time, so a discovery that missed a source
 * fails by not finding it, and every negative sits beside a positive.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LockInspection } from '../../../../src/config/lock-doctor.js'
import { CLIENT_IDS } from '../../../../src/install/paths.js'
import type { ClientId } from '../../../../src/install/paths.js'
import { discoverRoots } from '../../../../src/services/skill-recovery.discover.js'
import { listRecovery, listRoot } from '../../../../src/services/skill-recovery.listing.js'
import { rootLockEntries } from '../../../../src/services/skill-recovery.locks.js'
import {
  bindSkillsRootReadOnly,
  SkillWriteStop,
} from '../../../../src/services/skill-write-lock.js'
import { makeFixture, tmp, useTmpCleanup } from '../skill-swap.helpers.js'
import { deepSnapshot, opDirOf, opIdN } from '../skill-swap.scan.helpers.js'
import { journalOf, s2 } from './recovery.helpers.js'

useTmpCleanup()

const noJournal = (base: string): string => path.join(base, 'no-journal.jsonl')

/** Nine client roots under `base/clients/<id>`, all existing. */
function nineRoots(base: string): Record<ClientId, string> {
  const out = {} as Record<ClientId, string>
  for (const id of CLIENT_IDS) {
    out[id] = path.join(base, 'clients', id)
    fs.mkdirSync(out[id], { recursive: true })
  }
  return out
}

/** An op dir with an owner and no record (a crash before step 5): enough for a listing to find. */
function plantOp(root: string, opId: string): void {
  const dir = path.join(root, '.skillsmith-staging', opId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 1, host: 'h', uid: 0 }))
}

describe('T-J12: every one of the nine client roots is scanned', () => {
  for (const id of CLIENT_IDS) {
    it(`an op dir only in ${id}'s root is found without --root`, async () => {
      const base = tmp('recovery-discover-')
      const nativePaths = nineRoots(base)
      plantOp(nativePaths[id], opIdN('a'))
      const found = await discoverRoots({ cwd: base, homeDir: base, nativePaths })
      expect(found.roots).toHaveLength(9)
      const reports = await listRecovery(
        found.roots.map((r) => r.root),
        {
          journalFile: noJournal(base),
        }
      )
      const withOps = reports.filter((r) => r.ops.length > 0)
      expect(withOps.map((r) => r.root)).toEqual([fs.realpathSync(nativePaths[id])])
      expect(withOps[0]!.ops[0]!.opId).toBe(opIdN('a'))
      // The other eight were scanned too, and hold nothing.
      expect(reports.filter((r) => r.staging === 'absent')).toHaveLength(8)
    })
  }
})

describe('T-J12: the sources beyond the nine', () => {
  it('a root only the manifest names is scanned; without the entry it is not', async () => {
    const base = tmp('recovery-discover-')
    const nativePaths = nineRoots(base)
    const home = path.join(base, 'home')
    const extra = path.join(base, 'elsewhere', 'skills')
    fs.mkdirSync(path.join(home, '.skillsmith'), { recursive: true })
    fs.mkdirSync(path.join(extra, 'foo'), { recursive: true })
    const manifest = path.join(home, '.skillsmith', 'manifest.json')
    expect((await discoverRoots({ cwd: home, homeDir: home, nativePaths })).roots).toHaveLength(9)

    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: '1.0.0',
        installedSkills: { foo: { installPath: path.join(extra, 'foo') } },
      })
    )
    const found = await discoverRoots({ cwd: home, homeDir: home, nativePaths })
    expect(found.roots).toHaveLength(10)
    expect(found.roots.find((r) => r.root === fs.realpathSync(extra))?.sources).toEqual([
      'manifest:foo',
    ])
  })

  it('a root symlinked into another is one root, with both spellings and both sources', async () => {
    const base = tmp('recovery-discover-')
    const nativePaths = nineRoots(base)
    fs.rmSync(nativePaths.agents, { recursive: true })
    fs.symlinkSync(nativePaths['claude-code'], nativePaths.agents)
    const found = await discoverRoots({ cwd: base, homeDir: base, nativePaths })
    expect(found.roots).toHaveLength(8)
    const shared = found.roots.find((r) => r.root === fs.realpathSync(nativePaths['claude-code']))!
    expect(shared.sources).toEqual(['client:claude-code', 'client:agents'])
    expect(shared.spellings).toEqual([nativePaths['claude-code'], nativePaths.agents])
  })

  it('--state-root replaces the set of state roots and so the manifest roots it names', async () => {
    const base = tmp('recovery-discover-')
    const nativePaths = nineRoots(base)
    const home = path.join(base, 'home')
    const globalRoot = path.join(base, 'named-by-global')
    const explicitRoot = path.join(base, 'named-by-explicit')
    const explicitState = path.join(base, 'explicit-state')
    for (const d of [path.join(home, '.skillsmith'), explicitState, globalRoot, explicitRoot]) {
      fs.mkdirSync(d, { recursive: true })
    }
    const entry = (r: string) => ({
      version: '1.0.0',
      installedSkills: { s: { installPath: path.join(r, 's') } },
    })
    fs.writeFileSync(
      path.join(home, '.skillsmith', 'manifest.json'),
      JSON.stringify(entry(globalRoot))
    )
    fs.writeFileSync(path.join(explicitState, 'manifest.json'), JSON.stringify(entry(explicitRoot)))

    const byDefault = await discoverRoots({ cwd: home, homeDir: home, nativePaths })
    expect(byDefault.roots.map((r) => r.root)).toContain(fs.realpathSync(globalRoot))
    expect(byDefault.stateRoots).toEqual([fs.realpathSync(path.join(home, '.skillsmith'))])

    const replaced = await discoverRoots({
      cwd: home,
      homeDir: home,
      nativePaths,
      stateRoot: explicitState,
    })
    expect(replaced.stateRoots).toEqual([fs.realpathSync(explicitState)])
    expect(replaced.roots.map((r) => r.root)).toContain(fs.realpathSync(explicitRoot))
    expect(replaced.roots.map((r) => r.root)).not.toContain(fs.realpathSync(globalRoot))
  })

  it('--root adds a root; a root that does not exist is skipped and never created', async () => {
    const base = tmp('recovery-discover-')
    const nativePaths = nineRoots(base)
    const extra = path.join(base, 'extra-root')
    fs.mkdirSync(extra)
    const missing = path.join(base, 'not-there', 'skills')
    const found = await discoverRoots({
      cwd: base,
      homeDir: base,
      nativePaths,
      roots: [extra, missing],
    })
    expect(found.roots.map((r) => r.root)).toContain(fs.realpathSync(extra))
    expect(found.skipped).toContainEqual({ path: missing, source: '--root', errno: 'ENOENT' })
    expect(fs.existsSync(missing)).toBe(false)
    expect(fs.existsSync(path.join(base, 'not-there'))).toBe(false)
  })
})

describe('T-J12: workspace roots are found, and discovery makes no marker', () => {
  const withScopeEnv = (value: string | undefined): void => {
    const was = process.env.SKILLSMITH_SCOPE
    if (value === undefined) delete process.env.SKILLSMITH_SCOPE
    else process.env.SKILLSMITH_SCOPE = value
    cleanups.push(() => {
      if (was === undefined) delete process.env.SKILLSMITH_SCOPE
      else process.env.SKILLSMITH_SCOPE = was
    })
  }
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
  })

  it('a repository with no marker, under SKILLSMITH_SCOPE=workspace: nothing is created', async () => {
    const base = tmp('recovery-discover-')
    const nativePaths = nineRoots(base)
    const home = path.join(base, 'home')
    const repo = path.join(base, 'repo')
    fs.mkdirSync(path.join(home), { recursive: true })
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    withScopeEnv('workspace')
    const before = deepSnapshot(repo)
    const found = await discoverRoots({ cwd: path.join(repo, 'src'), homeDir: home, nativePaths })
    expect(deepSnapshot(repo)).toBe(before)
    for (const marker of ['.claude', '.cursor', '.agents', '.opencode']) {
      expect(fs.existsSync(path.join(repo, marker))).toBe(false)
    }
    expect(
      found.skipped.some((s) => s.source === 'workspace:claude-code' && s.errno === 'ENOENT')
    ).toBe(true)
    expect(found.roots.some((r) => r.sources.some((s) => s.startsWith('workspace:')))).toBe(false)
  })

  it('a repository with a marker: its skills folder and its .skillsmith state root are found', async () => {
    const base = tmp('recovery-discover-')
    const nativePaths = nineRoots(base)
    const home = path.join(base, 'home')
    const repo = path.join(base, 'repo')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.skillsmith'), { recursive: true })
    withScopeEnv('global')
    const found = await discoverRoots({ cwd: repo, homeDir: home, nativePaths })
    const ws = found.roots.find(
      (r) => r.root === fs.realpathSync(path.join(repo, '.claude', 'skills'))
    )
    expect(ws?.sources).toContain('workspace:claude-code')
    expect(found.stateRoots).toContain(fs.realpathSync(path.join(repo, '.skillsmith')))
  })
})

describe('the listing changes nothing', () => {
  it('a root with no staging is reported absent and no staging is made; a root with ops is listed', async () => {
    const base = tmp('recovery-discover-')
    const nativePaths = nineRoots(base)
    plantOp(nativePaths.cursor, opIdN('a'))
    const found = await discoverRoots({ cwd: base, homeDir: base, nativePaths })
    const before = deepSnapshot(path.join(base, 'clients'))
    const reports = await listRecovery(
      found.roots.map((r) => r.root),
      { journalFile: noJournal(base) }
    )
    expect(deepSnapshot(path.join(base, 'clients'))).toBe(before)
    const claude = reports.find((r) => r.root === fs.realpathSync(nativePaths['claude-code']))!
    expect(claude.staging).toBe('absent')
    expect(fs.existsSync(path.join(nativePaths['claude-code'], '.skillsmith-staging'))).toBe(false)
    expect(reports.find((r) => r.root === fs.realpathSync(nativePaths.cursor))!.ops).toHaveLength(1)
  })

  it('a crashed update: the skills root, its staging and the state root are byte-identical after listing', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const st = await s2(fx)
    const before = {
      skills: deepSnapshot(fx.skillsDir),
      state: deepSnapshot(fx.stateRoot),
    }
    const report = await listRoot(fx.skillsDir, { journalFile: journalOf(fx) })
    expect(report.ops.map((o) => o.opId)).toEqual([st.opId])
    expect(report.ops[0]!.cls.kind).toBe('state')
    expect(deepSnapshot(fx.skillsDir)).toBe(before.skills)
    expect(deepSnapshot(fx.stateRoot)).toBe(before.state)
  })
})

describe('bindSkillsRootReadOnly', () => {
  it('absent staging: null, and none is made', async () => {
    const root = tmp('recovery-bind-')
    expect(await bindSkillsRootReadOnly(root)).toBeNull()
    expect(fs.existsSync(path.join(root, '.skillsmith-staging'))).toBe(false)
  })

  it('existing staging: a binding that says it did not create it', async () => {
    const root = tmp('recovery-bind-')
    fs.mkdirSync(path.join(root, '.skillsmith-staging'), { mode: 0o700 })
    fs.chmodSync(root, 0o700)
    const binding = await bindSkillsRootReadOnly(root)
    expect(binding).not.toBeNull()
    expect(binding!.stagingCreated).toBe(false)
    expect(binding!.root).toBe(fs.realpathSync(root))
    expect(binding!.stagingDir).toBe(path.join(fs.realpathSync(root), '.skillsmith-staging'))
    expect(binding!.stagingBits).toMatchObject({
      state: 'not-applied',
      reason: 'existing-directory',
    })
  })

  const refusal = async (p: string): Promise<SkillWriteStop> => {
    try {
      await bindSkillsRootReadOnly(p)
    } catch (err) {
      if (err instanceof SkillWriteStop) return err
      throw err
    }
    throw new Error('expected a refusal')
  }

  it('a missing root, a file for a root, a symlinked staging and a staging file are refused', async () => {
    const base = tmp('recovery-bind-')
    expect((await refusal(path.join(base, 'nope'))).code).toBe('root-unsafe')
    fs.writeFileSync(path.join(base, 'file'), 'x')
    expect((await refusal(path.join(base, 'file'))).code).toBe('root-unsafe')

    const linked = path.join(base, 'linked')
    fs.mkdirSync(linked)
    fs.mkdirSync(path.join(base, 'target'))
    fs.symlinkSync(path.join(base, 'target'), path.join(linked, '.skillsmith-staging'))
    expect((await refusal(linked)).code).toBe('staging-unsafe')

    const plain = path.join(base, 'plain')
    fs.mkdirSync(plain)
    fs.writeFileSync(path.join(plain, '.skillsmith-staging'), 'x')
    expect((await refusal(plain)).code).toBe('staging-unsafe')
  })

  it('a staging dir that exposes more than its root does is refused; one that matches is bound', async () => {
    const base = tmp('recovery-bind-')
    const root = path.join(base, 'root')
    fs.mkdirSync(root)
    fs.chmodSync(root, 0o755)
    const staging = path.join(root, '.skillsmith-staging')
    fs.mkdirSync(staging)
    fs.chmodSync(staging, 0o755)
    expect(await bindSkillsRootReadOnly(root)).not.toBeNull()
    fs.chmodSync(staging, 0o777)
    // A world-writable staging under a root that others can only read is wider than its parent.
    expect((await refusal(root)).code).toBe('staging-unsafe')
  })

  it('a listing of a root with an unsafe staging says so and lists nothing', async () => {
    const base = tmp('recovery-bind-')
    const root = path.join(base, 'root')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, '.skillsmith-staging'), 'x')
    const report = await listRoot(root, { journalFile: noJournal(base) })
    expect(report).toMatchObject({ staging: 'unsafe', ops: [], probes: [] })
    expect(report.detail).toContain('not a usable directory')
  })
})

describe('T-X18 (e): leftover probes are listed, never skipped as dot names', () => {
  it('lists each probe with its type, leaves it in place, and skips other dot entries', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const st = await s2(fx)
    const probeA = path.join(fx.staging, '.skillsmith-probe-aaaa-1')
    const probeB = path.join(fx.staging, '.skillsmith-probe-aaaa-2')
    fs.mkdirSync(probeA)
    fs.mkdirSync(probeB)
    fs.writeFileSync(path.join(probeB, 'not-ours'), 'something else put this here')
    fs.mkdirSync(path.join(fx.staging, '.skillsmith-parked'))
    fs.mkdirSync(path.join(fx.staging, '.hidden-dir'))
    fs.writeFileSync(path.join(fx.staging, 'stray-file'), 'x')
    fs.mkdirSync(path.join(fx.staging, '.skillsmith-probe-nonsense'))

    const report = await listRoot(fx.skillsDir, { journalFile: journalOf(fx) })
    expect(report.probes.map((p) => [p.name, p.type])).toEqual([
      ['.skillsmith-probe-aaaa-1', 'dir'],
      ['.skillsmith-probe-aaaa-2', 'dir'],
    ])
    // Presence: the op dir is still listed and still a row; a probe never changes its state.
    expect(report.ops.map((o) => [o.opId, o.cls.kind])).toEqual([[st.opId, 'state']])
    // Nothing was removed by listing.
    expect(fs.existsSync(probeA)).toBe(true)
    expect(fs.existsSync(path.join(probeB, 'not-ours'))).toBe(true)
  })

  it('a probe that appears after a listing changes the staging digest, so the re-plan sees it', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    await s2(fx)
    const first = await listRoot(fx.skillsDir, { journalFile: journalOf(fx) })
    const again = await listRoot(fx.skillsDir, { journalFile: journalOf(fx) })
    expect(again.stagingDigest).toBe(first.stagingDigest)
    fs.mkdirSync(path.join(fx.staging, '.skillsmith-probe-bbbb-1'))
    const later = await listRoot(fx.skillsDir, { journalFile: journalOf(fx) })
    expect(later.stagingDigest).not.toBe(first.stagingDigest)
    expect(later.probes).toHaveLength(1)
  })

  it('an op dir whose entry is a symlink is not an op dir, and a probe that is a file is listed as one', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    fs.mkdirSync(fx.staging)
    fs.mkdirSync(path.join(fx.base, 'elsewhere'))
    fs.symlinkSync(path.join(fx.base, 'elsewhere'), opDirOf(fx, opIdN('c')))
    fs.writeFileSync(path.join(fx.staging, '.skillsmith-probe-dddd-1'), 'a file where a probe goes')
    const report = await listRoot(fx.skillsDir, { journalFile: journalOf(fx) })
    expect(report.ops).toEqual([])
    expect(report.probes.map((p) => [p.name, p.type])).toEqual([
      ['.skillsmith-probe-dddd-1', 'file'],
    ])
  })
})

describe('doctor locks over the discovered roots', () => {
  const claim = (ageNs: bigint, p: string): LockInspection => ({
    path: p,
    kind: 'v1',
    note: null,
    ino: 1n,
    uid: 0,
    mtimeNs: 0n,
    ageNs,
    bytes: Buffer.from('{}'),
    pid: 1,
    host: 'h',
    sameHost: true,
    pidAliveHere: false,
  })

  it("lists each root's write lock and its .reclaim, with their own ages to the nanosecond", () => {
    const roots = ['/r/one', '/r/two']
    const ages = new Map<string, bigint>([
      ['/r/one/.skillsmith-writes.lock', 5_000_000_000n],
      ['/r/one/.skillsmith-writes.lock.reclaim', 5_000_400_000n],
    ])
    const entries = rootLockEntries(roots, (p) => (ages.has(p) ? claim(ages.get(p)!, p) : null))
    expect(entries.map((e) => e.path)).toEqual([
      '/r/one/.skillsmith-writes.lock',
      '/r/one/.skillsmith-writes.lock.reclaim',
      '/r/two/.skillsmith-writes.lock',
      '/r/two/.skillsmith-writes.lock.reclaim',
    ])
    // Present entries carry what inspection found; absent ones are null, not dropped.
    expect(entries.map((e) => e.inspection === null)).toEqual([false, false, true, true])
    // A listing that kept only milliseconds would make these equal.
    expect(entries[0]!.inspection!.ageNs).toBe(5_000_000_000n)
    expect(entries[1]!.inspection!.ageNs).toBe(5_000_400_000n)
    expect(entries[0]!.inspection!.ageNs).not.toBe(entries[1]!.inspection!.ageNs)
  })

  it('with the real inspection: a lock and its reclaim are both listed, a missing one is null', () => {
    const root = tmp('recovery-locks-')
    const lock = path.join(root, '.skillsmith-writes.lock')
    fs.writeFileSync(lock, '4242')
    fs.writeFileSync(`${lock}.reclaim`, 'x')
    const [a, b] = rootLockEntries([root])
    expect(a!.path).toBe(lock)
    expect(a!.inspection).toMatchObject({ kind: 'bare-pid', pid: 4242 })
    expect(b!.path).toBe(`${lock}.reclaim`)
    expect(b!.inspection).not.toBeNull()
    const empty = rootLockEntries([tmp('recovery-locks-')])
    expect(empty.map((e) => e.inspection)).toEqual([null, null])
  })
})

/**
 * SMI-6531 (A1 step 7b): T-U1, the update target, and the units of Q10
 * (`realDir` a direct child of R, a directory on R's device) and Q11 (UD22's
 * non-owning key).
 *
 * T-U1 runs the whole path (`buildUpdateTarget`, `planSkillUpdate`,
 * `updateInPlace`) against a fake upstream whose repo name differs from the
 * folder name, and asserts by two snapshots plus one presence check (Q9):
 * inside the skills root only staging and `realDir` change; outside it only
 * the manifest, its lock and temps and this folder's backup area change; and
 * the run committed, with the manifest change at `manifestKeyFor(dirName,
 * client)`. Every refusal below is paired with a control that is accepted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCompanionAgentDir } from '../../../src/install/paths.js'
import { canonicalize, canonicalJson } from '../../../src/services/skill-manifest.canonical.js'
import { buildUpdateTarget } from '../../../src/services/skill-update.target.js'
import { manifestKeyOwner } from '../../../src/services/skill-update.owner.js'
import { planSkillUpdate } from '../../../src/services/skill-update.plan.js'
import { updateInPlace } from '../../../src/services/skill-update.js'
import type { UpdateTarget } from '../../../src/services/skill-update.types.js'
import { otherDevice, useOtherDeviceCleanup } from './skill-swap.xdev.helpers.js'
import {
  areaRel,
  changedBetween,
  readInstalled,
  recorded,
  SKILL_ID,
  skillMd,
  UPSTREAM_REPO,
  updateFixture,
  useTmpCleanup,
  useUpstream,
  useUpstreamCleanup,
  walk,
  writeManifest,
} from './skill-update.helpers.js'
import type { UpdateFixture } from './skill-update.helpers.js'

useTmpCleanup()
useUpstreamCleanup()
useOtherDeviceCleanup()

const LOCK_PREFIX = '.skillsmith-writes.lock'

function targetInput(fx: UpdateFixture, comparedPath = fx.comparedPath) {
  return {
    skillsDir: fx.skillsDir,
    client: fx.client,
    scope: 'global',
    manifestPath: fx.manifestPath,
    comparedPath,
  }
}

async function targetOf(fx: UpdateFixture, comparedPath?: string): Promise<UpdateTarget> {
  const r = await buildUpdateTarget(targetInput(fx, comparedPath))
  if (!r.ok) throw new Error(`target refused: ${r.reason}: ${r.detail}`)
  return r.target
}

/** Plans and executes the update of `target`; throws when planning refuses. */
async function updateOf(target: UpdateTarget) {
  const plan = await planSkillUpdate({ target, skillId: SKILL_ID, version: '2.0.0' })
  if (!plan.ok) throw new Error(`plan refused: ${plan.reason}: ${plan.detail}`)
  const rec = recorded()
  const result = await updateInPlace(plan, { swap: rec.swap })
  return { plan, result, rec }
}

/** Q9 snapshot 1: changes inside the skills root outside staging and `realDir`'s own name. */
function rootChangesOutside(
  before: Map<string, string>,
  after: Map<string, string>,
  realName: string
) {
  const changed = changedBetween(before, after).filter((r) => !r.startsWith(LOCK_PREFIX))
  const allowed = (r: string) =>
    r === '.skillsmith-staging' ||
    r.startsWith('.skillsmith-staging/') ||
    r === realName ||
    r.startsWith(`${realName}/`)
  return { changed, outside: changed.filter((r) => !allowed(r)) }
}

/** Q9 snapshot 2: changes in the state root outside the manifest files and the backup area. */
function stateChangesOutside(
  fx: UpdateFixture,
  before: Map<string, string>,
  after: Map<string, string>
) {
  const area = areaRel(fx)
  const chain = area.split(path.sep).map((_, i, a) => a.slice(0, i + 1).join('/'))
  const allowed = (r: string) =>
    r.startsWith('manifest.json') || chain.includes(r) || r.startsWith(`${area}/`)
  return changedBetween(before, after).filter((r) => !allowed(r))
}

describe('T-U1: repo name differs from the folder name (client cursor)', () => {
  it('commits, writes only staging, the folder, the manifest and the backup area, and keys by dirName', async () => {
    const upstream = useUpstream()
    upstream['SKILL.md'] = skillMd('v2')
    upstream['README.md'] = '# Readme\n\nHow to use the skill.\n'
    const fx = updateFixture(
      { 'SKILL.md': skillMd('v1'), 'notes.txt': 'mine\n' },
      { client: 'cursor' }
    )
    const companionDir = resolveCompanionAgentDir('cursor')
    const before = {
      root: walk(fx.skillsDir),
      state: walk(fx.stateRoot),
      companion: walk(companionDir),
      installed: readInstalled(fx.manifestPath),
    }

    const target = await targetOf(fx)
    expect(target.manifestKey).toBe('my-skill::cursor')
    expect(path.basename(target.companionPath ?? '')).toMatch(/^my-skill/)
    const { plan, result } = await updateOf(target)

    // The presence assertion: the run committed and changed the folder and its key.
    expect(result.status).toBe('committed')
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe(skillMd('v2'))
    const installed = readInstalled(fx.manifestPath)
    const changedKeys = Object.keys({ ...before.installed, ...installed }).filter(
      (k) => canonicalJson(before.installed[k]) !== canonicalJson(installed[k])
    )
    expect(changedKeys).toEqual(['my-skill::cursor'])
    expect(canonicalJson(installed['my-skill::cursor'])).toBe(canonicalJson(plan.postEntry))

    // Snapshot 1: inside the root, only staging and the folder changed (and the folder did).
    const inRoot = rootChangesOutside(before.root, walk(fx.skillsDir), 'my-skill')
    expect(inRoot.changed).toContain('my-skill/SKILL.md')
    expect(inRoot.outside).toEqual([])
    // Snapshot 2: outside it, only the manifest files and this folder's backup area.
    const afterState = walk(fx.stateRoot)
    expect(changedBetween(before.state, afterState)).toContain('manifest.json')
    expect(stateChangesOutside(fx, before.state, afterState)).toEqual([])
    expect(changedBetween(before.companion, walk(companionDir))).toEqual([])
    // No path anywhere carries the upstream name.
    const names = [...walk(fx.skillsDir).keys(), ...afterState.keys()]
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => n.includes(UPSTREAM_REPO))).toEqual([])
  })
})

describe('T-U1: a symlinked comparedPath', () => {
  it('resolves to the real direct child: dirName and key from the link, the folder updated behind it', async () => {
    const upstream = useUpstream()
    upstream['SKILL.md'] = skillMd('v2')
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const link = path.join(fx.skillsDir, 'link')
    fs.symlinkSync('my-skill', link)
    writeManifest(fx.manifestPath, { link: { ...fx.entry, installPath: link } })
    const before = { root: walk(fx.skillsDir), state: walk(fx.stateRoot) }

    const target = await targetOf(fx, link)
    expect(target).toMatchObject({ dirName: 'link', manifestKey: 'link', realDir: fx.realDir })
    const { result } = await updateOf(target)

    expect(result.status).toBe('committed')
    expect(fs.readlinkSync(link)).toBe('my-skill')
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe(skillMd('v2'))
    const inRoot = rootChangesOutside(before.root, walk(fx.skillsDir), 'my-skill')
    expect(inRoot.changed).toContain('my-skill/SKILL.md')
    expect(inRoot.outside).toEqual([])
    const linkFx = { ...fx, dirName: 'link' }
    expect(stateChangesOutside(linkFx, before.state, walk(fx.stateRoot))).toEqual([])
  })
})

describe('Q10: realDir is a direct child of R, a directory, on R’s device', () => {
  it('accepts the folder itself (the control for every refusal below)', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const r = await buildUpdateTarget(targetInput(fx))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.target.realDir).toBe(fx.realDir)
    expect(r.target.realSkillsDir).toBe(fs.realpathSync.native(fx.skillsDir))
    expect(canonicalJson(r.target.preEntry)).toBe(canonicalJson(canonicalize(fx.entry)))
    expect(Object.keys(r.target.preEntry)).toEqual(Object.keys(r.target.preEntry).sort())
  })

  it('refuses R itself, a nested directory and a regular file as identity-mismatch', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1'), 'sub/x.txt': 'x\n' })
    fs.writeFileSync(path.join(fx.skillsDir, 'file.txt'), 'f\n')
    for (const p of [
      fx.skillsDir,
      path.join(fx.realDir, 'sub'),
      path.join(fx.skillsDir, 'file.txt'),
    ]) {
      const r = await buildUpdateTarget(targetInput(fx, p))
      expect(r).toMatchObject({ ok: false, reason: 'identity-mismatch' })
    }
  })

  it('refuses a comparedPath or a skills root that does not resolve as probe-failed', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const missing = await buildUpdateTarget(targetInput(fx, path.join(fx.skillsDir, 'gone')))
    expect(missing).toMatchObject({ ok: false, reason: 'probe-failed' })
    const noRoot = await buildUpdateTarget({
      ...targetInput(fx),
      skillsDir: path.join(fx.base, 'no-root'),
    })
    expect(noRoot).toMatchObject({ ok: false, reason: 'probe-failed' })
  })

  it('refuses a realDir on another device (the lstat seam), creating nothing in the root', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const before = walk(fx.skillsDir)
    let seamSawRealDir = 0
    const shifted = async (p: string) => {
      const s = await fs.promises.lstat(p, { bigint: true })
      if (p !== fx.realDir) return s
      seamSawRealDir++
      return Object.assign(Object.create(Object.getPrototypeOf(s) as object) as fs.BigIntStats, s, {
        dev: s.dev + 1n,
      })
    }
    const r = await buildUpdateTarget(targetInput(fx), { lstat: shifted })
    expect(seamSawRealDir).toBe(1)
    expect(r).toMatchObject({ ok: false, reason: 'identity-mismatch' })
    expect(r.ok ? '' : r.detail).toContain('another device')
    expect(changedBetween(before, walk(fx.skillsDir))).toEqual([])

    // The control: the same seam passing the real stats through is accepted.
    const same = await buildUpdateTarget(targetInput(fx), {
      lstat: (p) => fs.promises.lstat(p, { bigint: true }),
    })
    expect(same.ok).toBe(true)
  })

  it('refuses a link whose target is outside R (on /dev/shm) as identity-mismatch', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const elsewhere = path.join(otherDevice(), 'foo')
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), skillMd('v1'))
    const link = path.join(fx.skillsDir, 'foo')
    fs.symlinkSync(elsewhere, link)
    writeManifest(fx.manifestPath, {
      'my-skill': fx.entry,
      foo: { ...fx.entry, installPath: link },
    })
    const r = await buildUpdateTarget(targetInput(fx, link))
    expect(r).toMatchObject({ ok: false, reason: 'identity-mismatch', path: elsewhere })
    expect((await buildUpdateTarget(targetInput(fx))).ok).toBe(true)
  })
})

describe('Q8 and the manifest', () => {
  it('refuses a folder with no entry at its key as untracked', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    writeManifest(fx.manifestPath, { other: fx.entry })
    expect(await buildUpdateTarget(targetInput(fx))).toMatchObject({
      ok: false,
      reason: 'untracked',
    })
    writeManifest(fx.manifestPath, { 'my-skill': fx.entry })
    expect((await buildUpdateTarget(targetInput(fx))).ok).toBe(true)
  })

  it('refuses an entry whose installPath does not name realDir as untracked (§4.3 row 4)', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const elsewhere = path.join(fx.skillsDir, 'other-skill')
    fs.mkdirSync(elsewhere)
    const noPath: Record<string, unknown> = { ...fx.entry }
    delete noPath.installPath
    const cases: Array<[Record<string, unknown>, string]> = [
      [noPath, 'missing or invalid installPath'],
      [{ ...fx.entry, installPath: '' }, 'missing or invalid installPath'],
      [{ ...fx.entry, installPath: 42 }, 'missing or invalid installPath'],
      [{ ...fx.entry, installPath: path.join(fx.base, 'gone') }, 'does not resolve'],
      [{ ...fx.entry, installPath: elsewhere }, `resolves to ${elsewhere}`],
    ]
    for (const [entry, detail] of cases) {
      writeManifest(fx.manifestPath, { 'my-skill': entry })
      const r = await buildUpdateTarget(targetInput(fx))
      expect(r).toMatchObject({ ok: false, reason: 'untracked' })
      expect(r.ok ? '' : r.detail).toContain(detail)
    }

    // The control: an installPath that is a symlink resolving to realDir is accepted.
    const alias = path.join(fx.base, 'alias')
    fs.symlinkSync(fx.realDir, alias)
    writeManifest(fx.manifestPath, { 'my-skill': { ...fx.entry, installPath: alias } })
    expect(await buildUpdateTarget(targetInput(fx))).toMatchObject({
      ok: true,
      target: { manifestKey: 'my-skill', realDir: fx.realDir },
    })
  })

  it('refuses a corrupt manifest as manifest-unreadable', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    fs.writeFileSync(fx.manifestPath, '{ not json')
    expect(await buildUpdateTarget(targetInput(fx))).toMatchObject({
      ok: false,
      reason: 'manifest-unreadable',
    })
  })
})

describe('Q11: one folder, several keys (UD22(4))', () => {
  const at = (installPath: string, installedAt: string) => ({ installPath, installedAt })

  it('manifestKeyOwner: literal path first, then the earliest installedAt, then the smallest key', () => {
    const real = '/r/foo'
    const viaLink = (p: string) => (p === '/l/foo' ? real : null)
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ b: at('/l/foo', '2020-01-01'), a: at(real, '2026-01-01') }, 'a'],
      [{ b: at(real, '2026-01-01'), a: at(real, '2026-06-01') }, 'b'],
      [{ b: at(real, '2026-01-01'), a: at(real, '2026-01-01') }, 'a'],
      [{ b: at(real, '2026-01-01'), a: at(real, 'not a date') }, 'b'],
      [{ b: at('/l/foo', '2026-02-01'), c: at('/l/foo', '2026-01-01') }, 'c'],
      [{ a: at('/elsewhere', '2020-01-01') }, null],
      [{ ['__proto__']: at(real, '2020-01-01'), constructor: at(real, '2021-01-01') }, '__proto__'],
      [{ a: 'not an object', b: at(real, '2026-01-01') }, 'b'],
    ]
    for (const [installedSkills, owner] of cases) {
      const raw = JSON.parse(JSON.stringify({ version: '1.0.0', installedSkills })) as unknown
      expect(manifestKeyOwner(raw, real, viaLink)).toBe(owner)
    }
    // Without a resolver only literal installPaths name the folder.
    const linked = { installedSkills: { c: at('/l/foo', '2026-01-01') } }
    expect(manifestKeyOwner(linked, real)).toBeNull()
    expect(manifestKeyOwner(linked, real, viaLink)).toBe('c')
  })

  it('refuses a non-owning key as identity-mismatch naming the owner; the owner is accepted', async () => {
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const link = path.join(fx.skillsDir, 'link')
    fs.symlinkSync('my-skill', link)
    writeManifest(fx.manifestPath, {
      link: { ...fx.entry, installPath: link, installedAt: '2020-01-01T00:00:00.000Z' },
      'my-skill': fx.entry,
    })
    const r = await buildUpdateTarget(targetInput(fx, link))
    expect(r).toMatchObject({
      ok: false,
      reason: 'identity-mismatch',
      owningManifestKey: 'my-skill',
    })
    const owner = await buildUpdateTarget(targetInput(fx))
    expect(owner).toMatchObject({ ok: true, target: { manifestKey: 'my-skill' } })
  })
})

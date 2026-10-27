/**
 * SMI-6531 (A1 step 6a-ii): refusals with zero mutation (T-J12's targeting
 * half, T-L15's refusals, T-J5's zero-mutation half, T-J6's checklist and its
 * swap between a check and its syscall). Each refusal is shown beside the
 * snapshot that proves nothing changed, and where it matters, beside the
 * positive that proves the same setup can act.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeRecordSha256 } from '../../../../src/services/skill-swap.js'
import type { SwapRecord } from '../../../../src/services/skill-swap.js'
import { areaOf, makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup, xdevFixture } from '../skill-swap.xdev.helpers.js'
import { copyTree, s2, s3, writeEntry } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, contentSnapshot, done } from './recovery.act.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

/** Everything a doctor action could touch: the skills root, the state root and the journal. */
const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)

describe('T-J12 targeting', () => {
  it('the same opId in two roots: recovery-ambiguous naming both; --root selects one', async () => {
    const st = await s2(file())
    const copy = path.join(st.fx.base, 'copied-skills')
    copyTree(st.fx.skillsDir, copy)
    const roots = [fs.realpathSync(st.fx.skillsDir), fs.realpathSync(copy)]
    const before = world(st)
    const amb = await act(st, 'apply', { roots })
    expect(amb.result).toMatchObject({ status: 'refused', reason: 'recovery-ambiguous' })
    if (amb.result.status === 'refused') {
      expect(amb.result.paths.sort()).toEqual(
        [
          path.join(roots[0]!, '.skillsmith-staging', st.opId),
          path.join(roots[1]!, '.skillsmith-staging', st.opId),
        ].sort()
      )
    }
    expect(world(st)).toBe(before)
    // On the copy: the record names the original root, so it is moved.
    const onCopy = await act(st, 'apply', { roots, root: copy })
    expect(onCopy.result).toMatchObject({ status: 'refused', reason: 'recovery-moved' })
    expect(world(st)).toBe(before)
    // A symlinked spelling of the original selects it, and only it.
    const link = path.join(st.fx.base, 'link-to-skills')
    fs.symlinkSync(st.fx.skillsDir, link)
    const a = await done(st, 'apply', { roots, root: link })
    expect(a.result.status).toBe('done')
    expect(fs.existsSync(path.join(copy, '.skillsmith-staging', st.opId))).toBe(true)
  })

  it('an op dir moved into another root refuses recovery-moved, offering only --abandon', async () => {
    const st = await s2(file())
    const other = path.join(st.fx.base, 'other-root')
    fs.mkdirSync(path.join(other, '.skillsmith-staging'), { recursive: true })
    fs.renameSync(st.opDir, path.join(other, '.skillsmith-staging', st.opId))
    const before = world(st)
    const a = await act(st, 'apply', { roots: [fs.realpathSync(other)] })
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-moved' })
    if (a.result.status === 'refused') expect(a.result.detail).toContain('--abandon')
    expect(world(st)).toBe(before)
  })

  it('an opId no root holds is refused, naming it', async () => {
    const st = await s2(file())
    const a = await act({ ...st, opId: 'z'.repeat(32) }, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})

describe('T-L15: a moved or copied root refuses recovery-moved with zero mutation', () => {
  it('a copy at the original path (same path, another identity)', async () => {
    const st = await s2(file())
    const moved = path.join(st.fx.base, 'moved-skills')
    fs.renameSync(st.fx.skillsDir, moved)
    copyTree(moved, st.fx.skillsDir)
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-moved' })
    expect(world(st)).toBe(before)
  })

  it('the moved root (same identity, another path)', async () => {
    const st = await s2(file())
    const moved = path.join(st.fx.base, 'moved-skills')
    fs.renameSync(st.fx.skillsDir, moved)
    const before = world(st)
    const a = await act(st, 'apply', { roots: [fs.realpathSync(moved)] })
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-moved' })
    expect(world(st)).toBe(before)
  })
})

describe('T-J5: identity changes refuse with zero mutation', () => {
  it('(a) T copied with cp -R: recovery-identity-changed; --accept-identity proceeds', async () => {
    const st = await s2(file())
    const aside = path.join(st.fx.base, 'aside')
    fs.renameSync(st.fx.realDir, aside)
    copyTree(aside, st.fx.realDir)
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-identity-changed' })
    expect(world(st)).toBe(before)
    const ok = await done(st, 'apply', { acceptIdentity: true })
    expect(ok.result.manifest).toBe('committed')
  })

  it('(b) an injected stat with the same ino and birthtime but another dev', async () => {
    const st = await s2(file())
    const before = world(st)
    const a = await act(st, 'apply', {
      reader: {
        statOverride: (p, real) =>
          p === st.fx.realDir && real.ok
            ? { ...real, identity: { ...real.identity, dev: `${real.identity.dev}9` } }
            : real,
      },
    })
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-identity-changed' })
    expect(world(st)).toBe(before)
  })

  it('(c) the old folder moved away: anything else, refused, zero mutation', async () => {
    const st = await s2(file())
    fs.renameSync(path.join(st.opDir, 'old'), path.join(st.fx.base, 'old-moved-away'))
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(world(st)).toBe(before)
    const u = await act(st, 'undo')
    expect(u.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(world(st)).toBe(before)
  })

  it('a stat matching dev, ino and birthtime but not the file type is not the role', async () => {
    const st = await s2(file())
    const before = world(st)
    const a = await act(st, 'apply', {
      reader: {
        statOverride: (p, real) =>
          p === st.fx.realDir && real.ok
            ? { ...real, identity: { ...real.identity, fmt: '32768' } }
            : real,
      },
    })
    expect(a.result.status).toBe('refused')
    expect(a.result).not.toMatchObject({ status: 'done' })
    expect(world(st)).toBe(before)
  })
})

describe('6a-iii lifts the one-device gate: cross-device and full-device plans are offered', () => {
  it('a backup area on another device than the skills root: --apply plans and finishes', async () => {
    const st = await s2(xdevFixture({ 'SKILL.md': '# v1\n' }))
    const a = await act(st, 'apply')
    expect(a.planned.status).toBe('planned')
    expect(a.result).toMatchObject({ status: 'done' })
    if (a.result.status === 'done') expect(a.result.extraCopy).not.toBeNull()
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(fs.existsSync(path.join(areaOf(st.fx), st.opId))).toBe(true)
  })

  it('a record with a full-device marker naming its own area, on one device: offered and finished', async () => {
    const st = await s2(file())
    const recPath = path.join(st.opDir, 'record.json')
    const r = JSON.parse(fs.readFileSync(recPath, 'utf8')) as SwapRecord
    const { recordSha256: _h, ...rest } = r
    const body = {
      ...rest,
      fullDevice: {
        cause: 'ENOSPC' as const,
        stage: 'copy' as const,
        area: areaOf(st.fx),
        opId: st.opId,
        dest: path.join(areaOf(st.fx), st.opId),
      },
    }
    fs.writeFileSync(
      recPath,
      JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) }, null, 2) + '\n'
    )
    const a = await done(st, 'apply')
    expect(a.result.status).toBe('done')
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('a full-device marker naming another area is anything else: --apply refused, zero mutation', async () => {
    const st = await s2(file())
    const recPath = path.join(st.opDir, 'record.json')
    const r = JSON.parse(fs.readFileSync(recPath, 'utf8')) as SwapRecord
    const { recordSha256: _h, ...rest } = r
    const elsewhere = path.join(st.fx.base, 'elsewhere')
    const body = {
      ...rest,
      fullDevice: {
        cause: 'ENOSPC' as const,
        stage: 'copy' as const,
        area: elsewhere,
        opId: st.opId,
        dest: path.join(elsewhere, st.opId),
      },
    }
    fs.writeFileSync(
      recPath,
      JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) }, null, 2) + '\n'
    )
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(world(st)).toBe(before)
  })

  // T4: each clause of the check fails alone, with the other two this op's own.
  const CLAUSES: Array<[string, (st: State) => { opId: string; dest: string }]> = [
    [
      'an opId that is not this op',
      (st) => ({ opId: 'b'.repeat(32), dest: path.join(areaOf(st.fx), st.opId) }),
    ],
    ['a dest outside its area', (st) => ({ opId: st.opId, dest: path.join(st.fx.base, st.opId) })],
  ]
  for (const [label, over] of CLAUSES) {
    it(`a full-device marker with ${label} alone is anything else; refused, zero mutation`, async () => {
      const st = await s2(file())
      const recPath = path.join(st.opDir, 'record.json')
      const { recordSha256: _h, ...rest } = JSON.parse(
        fs.readFileSync(recPath, 'utf8')
      ) as SwapRecord
      const body = {
        ...rest,
        fullDevice: {
          cause: 'ENOSPC' as const,
          stage: 'copy' as const,
          area: areaOf(st.fx),
          ...over(st),
        },
      }
      fs.writeFileSync(
        recPath,
        JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) })
      )
      const before = world(st)
      const a = await act(st, 'apply')
      expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
      expect(world(st)).toBe(before)
    })
  }
})

describe('T-J6: each broken condition ends with its named failure and zero mutation', () => {
  const rec = (st: State) => path.join(st.opDir, 'record.json')
  const cases: Array<[string, (st: State) => void, string]> = [
    [
      'a corrupt record',
      (st) => fs.writeFileSync(rec(st), '{ not json'),
      'recovery-record-unreadable',
    ],
    [
      'a wrong recordSha256',
      (st) => {
        const r = JSON.parse(fs.readFileSync(rec(st), 'utf8')) as Record<string, unknown>
        r.recordSha256 = '0'.repeat(64)
        fs.writeFileSync(rec(st), JSON.stringify(r, null, 2))
      },
      'recovery-record-unreadable',
    ],
    [
      'T a symlink',
      (st) => {
        const aside = path.join(st.fx.base, 'aside')
        fs.renameSync(st.fx.realDir, aside)
        fs.symlinkSync(aside, st.fx.realDir)
      },
      'recovery-not-offered',
    ],
    [
      'a copied T whose hash is neither pre nor post',
      (st) => {
        const aside = path.join(st.fx.base, 'aside')
        fs.renameSync(st.fx.realDir, aside)
        copyTree(aside, st.fx.realDir)
        fs.writeFileSync(path.join(st.fx.realDir, 'SKILL.md'), '# foreign\n')
      },
      'recovery-conflict',
    ],
    [
      'the manifest entry other',
      (st) => writeEntry(st.fx, { version: '9.9.9' }),
      'recovery-conflict',
    ],
    [
      'the recorded manifest unreadable',
      (st) => fs.writeFileSync(path.join(st.fx.stateRoot, 'manifest.json'), '{ nope'),
      'recovery-not-offered',
    ],
  ]
  for (const [name, breakIt, want] of cases) {
    it(name, async () => {
      const st = await s2(file())
      breakIt(st)
      const before = world(st)
      const a = await act(st, 'apply', { acceptIdentity: true })
      expect(a.result).toMatchObject({ status: 'refused', reason: want })
      expect(world(st)).toBe(before)
    })
  }

  it('a swap between a check and its syscall: the next check stops with backup-unsafe', async () => {
    const st = await s3(file())
    const area = areaOf(st.fx)
    const displaced = `${area}.displaced`
    const a = await act(
      st,
      'apply',
      {},
      {
        swap: {
          hooks: {
            beforeSidecar: () => {
              fs.renameSync(area, displaced)
              fs.symlinkSync(displaced, area)
            },
          },
        },
      }
    )
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'backup-unsafe' })
    expect(fs.readdirSync(displaced)).toEqual([])
    expect(fs.existsSync(path.join(st.opDir, 'old'))).toBe(true)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})

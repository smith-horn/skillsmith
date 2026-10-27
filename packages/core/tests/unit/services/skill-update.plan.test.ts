/**
 * SMI-6531 (A1 step 7b): T-U3, the touch set, and the planner's write-set and
 * `postEntry` rules (A1 plan §3.6, §3.7 items 2-5; Q5, Q6, Q12).
 *
 * T-U3 compares the folder before and after a real `updateInPlace`: it may
 * differ only in the approved write set, each approved path must hold exactly
 * the plan's bytes, and everything else must be byte-identical. The fake
 * upstream changes after planning, so an execution that fetched again would
 * write bytes the user never approved.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildUpdateTarget } from '../../../src/services/skill-update.target.js'
import { planSkillUpdate } from '../../../src/services/skill-update.plan.js'
import { updateInPlace } from '../../../src/services/skill-update.js'
import type { UpdatePlan, UpdateTarget } from '../../../src/services/skill-update.types.js'
import {
  changedBetween,
  recorded,
  sha256,
  SKILL_ID,
  skillMd,
  updateFixture,
  useTmpCleanup,
  useUpstream,
  useUpstreamCleanup,
  walk,
} from './skill-update.helpers.js'
import type { UpdateFixture } from './skill-update.helpers.js'

useTmpCleanup()
useUpstreamCleanup()

const README = '# Readme\n\nHow to use the skill.\n'
const OLD = {
  'SKILL.md': skillMd('v1'),
  'README.md': README,
  'examples.md': '# Examples\n\nold\n',
  'notes.txt': 'mine\n',
  'sub/x.txt': 'x\n',
}

function serveV2(upstream: Record<string, string>): void {
  upstream['SKILL.md'] = skillMd('v2')
  upstream['README.md'] = README
  upstream['examples.md'] = '# Examples\n\nnew\n'
  upstream['.claude/settings.json'] = '{}\n'
}

async function targetOf(fx: UpdateFixture): Promise<UpdateTarget> {
  const r = await buildUpdateTarget({
    skillsDir: fx.skillsDir,
    client: fx.client,
    scope: 'global',
    manifestPath: fx.manifestPath,
    comparedPath: fx.comparedPath,
  })
  if (!r.ok) throw new Error(`target refused: ${r.reason}: ${r.detail}`)
  return r.target
}

const NOW = new Date('2026-10-27T12:00:00.000Z')

async function planned(fx: UpdateFixture, version = '2.0.0'): Promise<UpdatePlan> {
  const plan = await planSkillUpdate({
    target: await targetOf(fx),
    skillId: SKILL_ID,
    version,
    now: () => NOW,
  })
  if (!plan.ok) throw new Error(`plan refused: ${plan.reason}: ${plan.detail}`)
  return plan
}

describe('the write set (§3.7 items 3-4, Q12)', () => {
  it('is SKILL.md plus the fetched optional files whose bytes differ, each modify or create', async () => {
    const upstream = useUpstream()
    serveV2(upstream)
    const fx = updateFixture(OLD)
    const plan = await planned(fx)
    const byRel = Object.fromEntries(plan.files.map((f) => [f.rel, f]))
    expect(Object.keys(byRel).sort()).toEqual(['.claude/settings.json', 'SKILL.md', 'examples.md'])
    expect(byRel['SKILL.md']).toMatchObject({ kind: 'modify', preSha256: sha256(OLD['SKILL.md']) })
    expect(byRel['examples.md']).toMatchObject({
      kind: 'modify',
      preSha256: sha256(OLD['examples.md']),
    })
    expect(byRel['.claude/settings.json']).toMatchObject({ kind: 'create', preSha256: null })
    for (const f of plan.files) expect(f.bytes.equals(Buffer.from(upstream[f.rel]!))).toBe(true)
    // A2's projection: create is 'add', and nothing is ever 'remove'.
    expect([...plan.writes].sort((a, b) => (a.rel < b.rel ? -1 : 1))).toEqual([
      { rel: '.claude/settings.json', mode: 'add' },
      { rel: 'SKILL.md', mode: 'modify' },
      { rel: 'examples.md', mode: 'modify' },
    ])
  })

  it('records every fetched optional file in fileHashes, the skipped README included, never SKILL.md', async () => {
    const upstream = useUpstream()
    serveV2(upstream)
    const fx = updateFixture(OLD, { entry: { fileHashes: { 'old.txt': 'f'.repeat(64) } } })
    const plan = await planned(fx)
    expect(plan.files.map((f) => f.rel)).not.toContain('README.md')
    expect(plan.postEntry.fileHashes).toEqual({
      'old.txt': 'f'.repeat(64),
      'README.md': sha256(README),
      'examples.md': sha256(upstream['examples.md']!),
      '.claude/settings.json': sha256('{}\n'),
    })
    const v2 = sha256(skillMd('v2'))
    expect(plan.postEntry).toMatchObject({
      originalContentHash: v2,
      upstreamContentHash: v2,
      version: '2.0.0',
      lastUpdated: NOW.toISOString(),
    })
    // Every field outside the allow-list is carried over unchanged.
    for (const k of ['id', 'name', 'source', 'installPath', 'installedAt', 'provenance']) {
      expect(plan.postEntry[k]).toEqual(fx.entry[k])
    }
    expect(plan.postEntry).not.toHaveProperty('verifiedAt')
  })

  it('keeps the recorded version when none is named', async () => {
    const upstream = useUpstream()
    serveV2(upstream)
    const fx = updateFixture(OLD)
    expect((await planned(fx, '')).postEntry.version).toBe('1.0.0')
    expect((await planned(fx, '3.1.0')).postEntry.version).toBe('3.1.0')
  })

  it('a file upstream no longer serves stays in the folder and keeps its baseline (Q12)', async () => {
    const upstream = useUpstream()
    upstream['SKILL.md'] = skillMd('v2')
    const fx = updateFixture(OLD, {
      entry: { fileHashes: { 'examples.md': sha256(OLD['examples.md']) } },
    })
    const plan = await planned(fx)
    expect(plan.files.map((f) => f.rel)).toEqual(['SKILL.md'])
    const result = await updateInPlace(plan, { swap: recorded().swap })
    expect(result.status).toBe('committed')
    expect(fs.readFileSync(path.join(fx.realDir, 'examples.md'), 'utf8')).toBe(OLD['examples.md'])
    expect(plan.postEntry.fileHashes).toEqual({ 'examples.md': sha256(OLD['examples.md']) })
  })
})

describe('unsupported entries at a write-set path (§3.7 item 4)', () => {
  it('a FIFO swapped in at README.md after the target is built is unsupported-entry, never opened', async () => {
    const upstream = useUpstream()
    serveV2(upstream)
    const fx = updateFixture(OLD)
    const target = await targetOf(fx)
    const readme = path.join(fx.realDir, 'README.md')
    fs.rmSync(readme)
    const mk = spawnSync('mkfifo', [readme])
    if (mk.status !== 0) throw new Error(`mkfifo failed: ${String(mk.stderr)}`)
    // Opening a FIFO for reading without O_NONBLOCK would hang this test; it returns instead.
    const r = await planSkillUpdate({ target, skillId: SKILL_ID })
    expect(r).toMatchObject({ ok: false, reason: 'unsupported-entry', path: readme })

    // The control: the same fixture with a regular README plans.
    const fx2 = updateFixture(OLD)
    expect((await planSkillUpdate({ target: await targetOf(fx2), skillId: SKILL_ID })).ok).toBe(
      true
    )
  })

  it('a hard link, a symlink and a non-directory parent are each unsupported-entry', async () => {
    const upstream = useUpstream()
    serveV2(upstream)
    const shapes: Array<(fx: UpdateFixture) => string> = [
      (fx) => {
        const p = path.join(fx.realDir, 'examples.md')
        fs.linkSync(p, path.join(fx.base, 'second-link'))
        return p
      },
      (fx) => {
        const p = path.join(fx.realDir, 'examples.md')
        fs.rmSync(p)
        fs.symlinkSync('notes.txt', p)
        return p
      },
      (fx) => {
        const p = path.join(fx.realDir, '.claude')
        fs.writeFileSync(p, 'a file\n')
        return p
      },
    ]
    for (const shape of shapes) {
      const fx = updateFixture(OLD)
      const target = await targetOf(fx)
      const at = shape(fx)
      expect(await planSkillUpdate({ target, skillId: SKILL_ID })).toMatchObject({
        ok: false,
        reason: 'unsupported-entry',
        path: at,
      })
    }
  })
})

describe('refusals from fetch and scan', () => {
  it('no SKILL.md upstream is fetch-failed, with nothing written', async () => {
    useUpstream()
    const fx = updateFixture(OLD)
    const before = walk(fx.skillsDir)
    const r = await planSkillUpdate({ target: await targetOf(fx), skillId: SKILL_ID })
    expect(r).toMatchObject({
      ok: false,
      reason: 'fetch-failed',
      install: { errorCode: 'FETCH_FAILED' },
    })
    expect(changedBetween(before, walk(fx.skillsDir))).toEqual([])
  })

  it('skipScan for an unreviewed tier is scan-rejected (install’s own gate)', async () => {
    const upstream = useUpstream()
    serveV2(upstream)
    const fx = updateFixture(OLD)
    const r = await planSkillUpdate({
      target: await targetOf(fx),
      skillId: SKILL_ID,
      skipScan: true,
    })
    expect(r).toMatchObject({
      ok: false,
      reason: 'scan-rejected',
      install: { errorCode: 'SKIP_SCAN_FORBIDDEN' },
    })
  })
})

describe('T-U3: the new folder differs from the old only in the approved write set', () => {
  it('each approved path holds the plan’s bytes; every other path is byte-identical', async () => {
    const upstream = useUpstream()
    serveV2(upstream)
    const fx = updateFixture(OLD)
    const before = walk(fx.realDir)
    const plan = await planned(fx)
    // Upstream moves on after the plan: an approved path and a path outside the set.
    upstream['SKILL.md'] = skillMd('v3')
    upstream['README.md'] = '# Readme\n\nchanged after the plan\n'

    const result = await updateInPlace(plan, { swap: recorded().swap })
    expect(result.status).toBe('committed')
    const approved = new Set(plan.files.map((f) => f.rel))
    // A directory the write set created is the only other allowed change.
    const created = new Set(['.claude'])
    const changed = changedBetween(before, walk(fx.realDir))
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.filter((r) => !approved.has(r) && !created.has(r))).toEqual([])
    for (const f of plan.files) {
      expect(sha256(fs.readFileSync(path.join(fx.realDir, f.rel)))).toBe(sha256(f.bytes))
    }
    expect(fs.readFileSync(path.join(fx.realDir, 'README.md'), 'utf8')).toBe(README)
  })
})

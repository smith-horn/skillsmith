/**
 * SMI-6531 (A1 step 7b): T-C1, the manifest CAS before the swap, with the
 * real `apply_manifest_reconcile` `mark_local` action as the concurrent writer
 * (A1 plan §3.6, T-C1; design Q13: it lives here because `runMarkLocal` is
 * mcp-server's and core may not depend on it).
 *
 * `mark_local` runs between the plan and lock 1, in two places: inside the
 * swap's `afterBuild` hook (step 1, before lock 1), and between
 * `planSkillUpdate` and the `updateInPlace` call. Either way step 4's CAS must
 * refuse `changed-since-plan` before any rename: the trace holds no `rename`
 * and no `link` of `record.json`, the real port (wrapped in a counting proxy)
 * is entered exactly once (step 4's hold) and its `write()` never runs, and
 * the folder keeps its identity and tree hash. The second placement is what
 * catches an `updateInPlace` that re-reads `preEntry` at call time instead of
 * taking it from the plan. Each absence is read beside a control run on the
 * same fixture that does rename, enter the port twice and write once.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildUpdateTarget,
  planSkillUpdate,
  treeHashOf,
  updateInPlace,
  type ManifestPort,
  type TraceOp,
  type UpdatePlan,
} from '@skillsmith/core'
import { runMarkLocal } from '../../src/tools/apply-manifest-reconcile.actions.js'
import type { ToolContext } from '../../src/context.js'

const OP_ID = 'c'.repeat(32)
const REPO = 'upstream-name'
const SKILL_ID = `https://github.com/acme/${REPO}`
const SKILL_V1 = '# My skill v1\n\n' + 'This skill formats release notes for the team. '.repeat(4)
const SKILL_V2 = '# My skill v2\n\n' + 'This skill formats release notes for the team. '.repeat(4)

const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

/** The fake upstream: SKILL.md v2, everything else a 404. */
function serveUpstream(): void {
  const prefix = `https://raw.githubusercontent.com/acme/${REPO}/main/`
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) =>
      String(url) === `${prefix}SKILL.md`
        ? new Response(SKILL_V2, { status: 200 })
        : new Response('not found', { status: 404 })
    )
  )
}

interface Fixture {
  skillsDir: string
  manifestPath: string
  realDir: string
}

function fixture(): Fixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-in-place-cas-')))
  roots.push(base)
  const skillsDir = path.join(base, 'skills')
  const realDir = path.join(skillsDir, 'my-skill')
  const state = path.join(base, 'state')
  fs.mkdirSync(realDir, { recursive: true })
  fs.mkdirSync(state)
  fs.writeFileSync(path.join(realDir, 'SKILL.md'), SKILL_V1)
  const manifestPath = path.join(state, 'manifest.json')
  const entry = {
    id: SKILL_ID,
    name: 'my-skill',
    version: '1.0.0',
    source: 'github:acme/upstream-name',
    installPath: realDir,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    provenance: 'registry',
  }
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ version: '1.0.0', installedSkills: { 'my-skill': entry } }, null, 2)
  )
  return { skillsDir, manifestPath, realDir }
}

async function planOf(fx: Fixture): Promise<UpdatePlan> {
  const t = await buildUpdateTarget({
    skillsDir: fx.skillsDir,
    client: 'claude-code',
    scope: 'global',
    manifestPath: fx.manifestPath,
    comparedPath: fx.realDir,
  })
  if (!t.ok) throw new Error(`target refused: ${t.detail}`)
  const plan = await planSkillUpdate({ target: t.target, skillId: SKILL_ID })
  if (!plan.ok) throw new Error(`plan refused: ${plan.detail}`)
  return plan
}

/** The real `mark_local` action against the fixture's manifest. */
const markLocal = (fx: Fixture) => async (): Promise<void> => {
  await runMarkLocal(
    { action: 'mark_local', name: 'my-skill' },
    { manifestPath: fx.manifestPath, client: 'claude-code', scope: 'global' },
    {} as ToolContext
  )
}

/** Counts lock-3 holds and `write()` calls through the real port. */
function counting(): { wrap: (p: ManifestPort) => ManifestPort; holds: number; writes: number } {
  const c = {
    holds: 0,
    writes: 0,
    wrap: (real: ManifestPort): ManifestPort => ({
      withManifestLock: (fn) =>
        real.withManifestLock((m) => {
          c.holds++
          return fn({
            ...m,
            write: async () => {
              c.writes++
              await m.write()
            },
          })
        }),
    }),
  }
  return c
}

async function run(plan: UpdatePlan, hooks: { afterBuild?: () => Promise<void> } = {}) {
  const trace: TraceOp[] = []
  const count = counting()
  const result = await updateInPlace(plan, {
    wrapPort: count.wrap,
    swap: {
      opId: OP_ID,
      trace: (op) => trace.push(op),
      appendJournal: async () => undefined,
      stderr: () => undefined,
      hooks,
    },
  })
  return { result, trace, count }
}

const renames = (t: TraceOp[]) => t.filter((x) => x.op === 'rename')
/** The trace's ops that create, link or rename anything to `record.json`. */
const recordOps = (t: TraceOp[]) =>
  t.filter(
    (x) =>
      ((x.op === 'link' || x.op === 'rename') && x.dest.endsWith('record.json')) ||
      (x.op === 'create' && x.path.endsWith('record.json'))
  )

/** The raw manifest entry for the fixture's skill. */
function entryOf(fx: Fixture): Record<string, unknown> | undefined {
  const raw = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8')) as {
    installedSkills: Record<string, Record<string, unknown>>
  }
  return raw.installedSkills['my-skill']
}

function assertRefusedBeforeSwap(
  fx: Fixture,
  plan: UpdatePlan,
  r: Awaited<ReturnType<typeof run>>
): void {
  expect(r.result).toMatchObject({ status: 'refused', reason: 'changed-since-plan' })
  // The trigger fired and nothing overwrote it: the entry is still the real action's.
  expect(entryOf(fx)).toMatchObject({ provenance: 'local', source: 'unknown' })
  expect(renames(r.trace)).toEqual([])
  expect(r.count.holds).toBe(1)
  expect(r.count.writes).toBe(0)
  expect(recordOps(r.trace)).toEqual([])
  expect(fs.existsSync(path.join(fx.skillsDir, '.skillsmith-staging', OP_ID, 'record.json'))).toBe(
    false
  )
  const id = fs.lstatSync(fx.realDir, { bigint: true })
  expect([id.dev, id.ino]).toEqual([plan.target.identity.dev, plan.target.identity.ino])
  const h = treeHashOf(fx.realDir)
  expect(h.ok && h.hash).toBe(plan.target.preTree)
  expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe(SKILL_V1)
}

describe('T-C1: mark_local between the plan and lock 1', () => {
  it('in afterBuild: step 4 refuses changed-since-plan before any rename or record', async () => {
    serveUpstream()
    const fx = fixture()
    const plan = await planOf(fx)
    const r = await run(plan, { afterBuild: markLocal(fx) })
    assertRefusedBeforeSwap(fx, plan, r)
  })

  it('between planSkillUpdate and updateInPlace: the same refusal (preEntry comes from the plan)', async () => {
    serveUpstream()
    const fx = fixture()
    const plan = await planOf(fx)
    await markLocal(fx)()
    // The trigger fired before the run, so a later failure is the update's, not the trigger's.
    expect(entryOf(fx)).toMatchObject({ provenance: 'local', source: 'unknown' })
    const r = await run(plan)
    assertRefusedBeforeSwap(fx, plan, r)
  })

  it('the control: the same fixture without mark_local renames, enters the port twice and writes once', async () => {
    serveUpstream()
    const fx = fixture()
    const plan = await planOf(fx)
    const r = await run(plan)
    expect(r.result.status).toBe('committed')
    expect(renames(r.trace).length).toBeGreaterThanOrEqual(2)
    expect(recordOps(r.trace).length).toBeGreaterThanOrEqual(1)
    expect(r.count.holds).toBe(2)
    expect(r.count.writes).toBe(1)
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe(SKILL_V2)
  })
})

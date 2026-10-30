/**
 * SMI-6531 (A1 step 6b-iii): the plan table's rows for `doctor recovery
 * --abandon <opId>` (A1 plan §3.9, PLAN:2022; design `step6b-design.md`
 * § 1.3, C1, C4, O2, O4).
 *
 * Offered only where no normal recovery action can run, for a verified
 * record: `moved` (any why, with the facts it observes in this root),
 * `identity-changed` (without `--accept-identity`; with it the classifier
 * returns the row), `ab` (an abandon began), `anything-else` with facts, and
 * post-keep S2′ (`rowAbandon` in `skill-recovery.plan.ts`). A no-record op
 * dir whose `move-source` intent verifies is finished as `--apply` does
 * (`intentParkPlan`); an empty op dir is one `rmdir` (`emptyPlan`).
 *
 * Refused with zero mutation, naming what to do: `anything-else` with no facts
 * (the op dir entry is not a directory, so no record verified: C4); a role in
 * the op dir that is not a directory, or a metadata file it holds that is not
 * provably this op's (O2: move it out by hand and run the command again); a
 * keep in the area no sub-state names, until the user resolves it, except
 * the two this action keeps itself: an orphan copy temp (kept as
 * `partial-copy`, or, when a pending partial-copy keep names it, finished by
 * its rename) and a P4 copy whose source changed after it (PLAN:1559: the
 * changed source is kept fresh and the copy becomes P5).
 *
 * The plan mirrors the executor (`skill-recovery.abandon.ts`), as #3204 did
 * for `--clean-staging`: each role that is still in the op dir is one step
 * (a keep that had started resumes with its own kind, PLAN:1536; any other
 * source is kept as `abandoned-old|new|undone`); a role already kept says so;
 * an absent role has no step. Each fresh keep is named as `destFor` will name
 * it: the first of `<opId>.<kind>`, `.1`, `.2`... that no tree, sidecar or
 * sidecar temp in the area holds (`freeKeptName`; the listing is in the
 * digest). Then what is left, in run order: each orphan copy temp (kept
 * first, so a fresh keep's own copy temp name is free), then per role O, N, U
 * the resume of its started keep or the unlink of its provable P0 temp, then
 * the finish as `skill-recovery.plan.finish.ts` states it (both finishes while
 * a source is still to be kept).
 *
 * Pure: no filesystem access.
 *
 * @module @skillsmith/core/services/skill-recovery.plan.abandon
 */
import path from 'node:path'
import {
  kept,
  offer,
  recordVerifies,
  refuse,
  step,
  UNTOUCHED,
} from './skill-recovery.plan.actions.js'
import { finishLines, strayDetail } from './skill-recovery.plan.finish.js'
import { pendingOf } from './skill-recovery.pending.js'
import { isProvableTemp, ROLE_DIR } from './skill-recovery.pstate.js'
import { sameId } from './skill-recovery.trees.js'
import type {
  ActionPlan,
  KeepGroup,
  OpFacts,
  PlanStep,
  RecoveryAction,
  RecoveryClass,
  Role,
} from './skill-recovery.types.js'

const BY_HAND = 'move it out of the op dir by hand, and run the command again'

/** The kind a source no keep has started is kept as. */
const ABANDONED_KIND: Readonly<Record<Role, string>> = {
  O: 'abandoned-old',
  N: 'abandoned-new',
  U: 'abandoned-undone',
}

/**
 * A copy temp with no sidecar, sidecar temp or tree: a copy that never
 * published (kept as `partial-copy`, or, when a pending partial-copy keep
 * names it, finished by its rename).
 */
export function isOrphanCopyTemp(g: KeepGroup): boolean {
  return (
    !g.otherCopy &&
    g.state === null &&
    g.sidecar === null &&
    g.sidecarTmp === null &&
    g.copyTmp.present &&
    !g.dest.present
  )
}

/**
 * P4 whose source changed after the copy (PLAN:1559): the verified copy at
 * `dest` matches its sidecar and the source no longer does. The copy stays as
 * it is (P5 once the source leaves), and the source is kept fresh.
 */
function isChangedAfterCopy(g: KeepGroup): boolean {
  const sc = g.sidecar
  return (
    !g.otherCopy &&
    g.state === null &&
    sc !== null &&
    sc.validForOp &&
    sc.treeHash !== null &&
    g.src.present &&
    g.src.type === 'dir' &&
    sameId(g.src.identity, sc.identity) &&
    g.dest.present &&
    g.dest.hash === sc.treeHash &&
    !g.copyTmp.present &&
    g.src.hash !== sc.treeHash
  )
}

/**
 * A sidecar temp the run would have to unlink but cannot prove is this op's
 * (`isProvableTemp`): a P0 temp of a source role no keep has started (`keepRole`
 * unlinks it first), or the temp of a started R1 or R2 (`resumeGroup`: R1
 * unlinks it unless it finishes the rewrite; R2 links it and needs it to name
 * the source). Its path, or null.
 */
function unprovableTemp(f: OpFacts): string | null {
  for (const role of ['O', 'N', 'U'] as const) {
    const res = f.roles[role]
    if (res.kind !== 'source') continue
    const g = res.started
    if (g === null) {
      const p0 = f.groups.find((x) => x.role === role && x.state === 'P0' && !isProvableTemp(x))
      if (p0 !== undefined) return `${p0.destPath}.json.tmp`
    } else if (g.state === 'R1' && !isProvableTemp(g)) {
      return `${g.destPath}.json.tmp`
    } else if (g.state === 'R2' && (!isProvableTemp(g) || g.sidecarTmp?.emptySingleLink === true)) {
      return `${g.destPath}.json.tmp`
    }
  }
  return null
}

/** Why `--abandon` cannot act on what the classifier saw, naming the entry (O2); null when it can. */
function blockOf(f: OpFacts): string | null {
  const stray = strayDetail(f)
  if (stray !== null) return stray
  const t = f.recordTmp
  // `adoptAll`'s rule: a marked temp whose body matches the record is this op's.
  if (t !== null && !t.sameInode && !t.emptySingleLink && !t.bodyMatches) {
    return `${t.path} is not provably this operation's; ${BY_HAND}`
  }
  if (f.parkIntent !== null && !f.parkIntent.valid) {
    return `${f.parkIntent.path} is not this op dir's move-source park intent; ${BY_HAND}`
  }
  if (f.parkIntentTmp !== null && !f.parkIntentTmp.provable) {
    return `${f.parkIntentTmp.path} is not provably this operation's; ${BY_HAND}`
  }
  for (const role of ['O', 'N', 'U'] as const) {
    const res = f.roles[role]
    if (res.kind === 'source' && res.obs.type !== 'dir') {
      return `${path.join(f.opDir, ROLE_DIR[role])} is not a directory, so it is not kept; ${BY_HAND}`
    }
  }
  const unprovable = unprovableTemp(f)
  if (unprovable !== null) {
    return `${unprovable} is not provably this operation's sidecar temp, so it is not unlinked; ${BY_HAND}`
  }
  const odd = f.groups.find(
    (g) => g.unclassified !== null && !isOrphanCopyTemp(g) && !isChangedAfterCopy(g)
  )
  if (odd !== undefined) {
    return `${odd.destPath} is kept but ${odd.unclassified}: resolve it by hand, and run the command again`
  }
  return null
}

/**
 * Where a fresh keep of `kind` goes: `<area>/<opId>.<kind>`, or the first
 * `.<k>` suffix free of a tree, sidecar or sidecar temp in the area, as
 * `destFor` (`taken`) chooses it. A copy temp does not take a name; the
 * executor keeps orphan copy temps first, so it is free by then; nor does a
 * P0 temp of a role still to be kept, which `keepRole` unlinks before that
 * role's publish (its name's kind is that role's).
 */
export function freeKeptName(
  f: Pick<OpFacts, 'area' | 'opId' | 'groups' | 'roles'>,
  kind: string
): string {
  const base = `${f.opId}.${kind}`
  const unlinkedFirst = (g: KeepGroup): boolean => {
    const res = g.role === null ? null : f.roles[g.role]
    return g.state === 'P0' && res?.kind === 'source' && res.started === null
  }
  const taken = new Set(
    f.groups
      .filter((g) => g.dest.present || g.sidecar !== null || g.sidecarTmp !== null)
      .filter((g) => !unlinkedFirst(g))
      .map((g) => g.base)
  )
  let name = base
  for (let k = 1; taken.has(name); k++) name = `${base}.${k}`
  return path.join(f.area, name)
}

/** The one step for `role`, or none when it is absent. */
function roleStep(f: OpFacts, role: Role): PlanStep[] {
  const res = f.roles[role]
  if (res.kind === 'absent') return []
  if (res.kind === 'kept') {
    return [step(role, kept(res.keep.kind), `already kept at ${res.keep.destPath}`)]
  }
  if (res.started !== null) {
    const g = res.started
    return [
      step(role, kept(g.kind), `resumes the keep ${g.base} from ${g.state} with its own kind`),
    ]
  }
  const kind = ABANDONED_KIND[role]
  return [
    step(role, kept(kind), `${ROLE_DIR[role]}/ is kept as ${kind} at ${freeKeptName(f, kind)}`),
  ]
}

/** Where the old folder ends, in words, for the "the skill path stays empty" note. */
function oldWhere(f: OpFacts): string | null {
  const o = f.roles.O
  if (o.kind === 'absent') return null
  if (o.kind === 'kept') return o.keep.destPath
  if (o.started !== null) return o.started.destPath
  return freeKeptName(f, ABANDONED_KIND.O)
}

/** Per role, as `keepOne` takes it: a started keep's resume, else the unlink of a provable P0 temp. */
function roleLines(f: OpFacts): string[] {
  const out: string[] = []
  for (const role of ['O', 'N', 'U'] as const) {
    const res = f.roles[role]
    if (res.kind !== 'source') continue
    if (res.started !== null) {
      const pending = pendingOf(f, res.started)
      out.push(
        `resume the keep of ${res.started.base} from ${res.started.state}` +
          (pending === null ? '' : `, finishing its copy temp's partial-copy keep as ${pending}`)
      )
      continue
    }
    for (const g of f.groups.filter((x) => x.role === role && x.state === 'P0')) {
      out.push(`unlink the empty (or this op's own) sidecar temp of ${g.base} (P0)`)
    }
  }
  return out
}

/** `--abandon` of a verified op whose facts are `f` (see the module comment). */
export function abandonOf(opId: string, f: OpFacts): ActionPlan {
  const blocked = blockOf(f)
  if (blocked !== null) return refuse('abandon', 'recovery-not-offered', blocked)
  const steps: PlanStep[] = [
    ...(f.t.present ? [step('T', UNTOUCHED, `the folder at ${f.tPath} stays as it is`)] : []),
    ...roleStep(f, 'O'),
    ...roleStep(f, 'N'),
    ...roleStep(f, 'U'),
  ]
  const source = (['O', 'N', 'U'] as const).some((r) => f.roles[r].kind === 'source')
  const orphans = f.groups.filter(isOrphanCopyTemp)
  const remaining = [
    ...orphans.map((g) => {
      const temp = path.join(f.area, `.tmp-${g.base}`)
      const pending = pendingOf(f, g)
      return pending === null
        ? `keep the copy temp ${temp} as partial-copy`
        : `finish keeping the copy temp ${temp} as ${pending} (its partial-copy sidecar is published; only the rename is left)`
    }),
    ...roleLines(f),
    ...finishLines(f, source),
  ]
  const old = oldWhere(f)
  const notes = [
    `kept into ${f.area}, the backup area of this skills root, named with the op dir's own name (${opId})`,
    ...(f.moved === null
      ? []
      : [
          `the record belongs to another root or op dir (${f.moved}): only this op dir's trees are kept`,
        ]),
    ...(source
      ? [
          'if the backup area is on another device, each tree is copied and verified first, and the op dir is then set aside whole with them',
        ]
      : []),
    ...(f.t.present
      ? []
      : [
          old === null
            ? 'the skill path stays empty'
            : `the skill path stays empty; the old folder is kept at ${old}`,
        ]),
    'the skill folder, the manifest entry and the audit journal are untouched',
  ]
  return offer('abandon', steps, 'untouched', remaining, notes)
}

/**
 * Why an action other than `--abandon` is refused for a class no other row
 * plans: an abandon that began, or (anything else) the classifier's own
 * reason, so each refusal names what is wrong (an ambiguous partial-copy keep,
 * say), and for one with no verified record that none verifies. Otherwise
 * (`--clean-staging` or `--park` of a moved or identity-changed op) the
 * record verifies, and what `action` acts on instead. None of these names
 * another action: whether `--abandon` (or any other) is offered is the hint's
 * to say (`skill-recovery.plan.hint.ts`).
 */
export function refusedWord(cls: RecoveryClass, action: RecoveryAction): string {
  if (cls.kind === 'ab') return 'an abandon began'
  if (cls.kind === 'anything-else') {
    return cls.facts === null ? `${cls.reason}, so no record verifies` : cls.reason
  }
  return recordVerifies(action)
}

/**
 * `--abandon` for the classes that carry a verified record's facts (all but
 * a §3.3 row, which `rowAbandon` plans); null when the class says nothing here.
 */
export function abandonPlan(cls: RecoveryClass): ActionPlan | null {
  switch (cls.kind) {
    case 'moved':
    case 'identity-changed':
    case 'ab':
      return abandonOf(cls.opId, cls.facts)
    case 'anything-else':
      // C4: no record verified (the op dir entry is not a directory): nothing it may act on.
      return cls.facts === null
        ? refuse(
            'abandon',
            'recovery-not-offered',
            `${cls.reason}, so no record verifies: --abandon acts only on a verified record; ${BY_HAND}`
          )
        : abandonOf(cls.opId, cls.facts)
    default:
      return null
  }
}

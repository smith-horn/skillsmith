/**
 * SMI-6531 (A1 step 6c-i): what a `.prune-*` staging leftover is, read-only
 * (ADR-166 D-11 "Crash recovery"), ported from the SMI-6676 spike's
 * `prune.leftovers.mjs`. Prune's listing acts on the result and doctor reuses
 * it; neither is wired yet (6c-ii, 6c-iii).
 *
 * Only a leftover holding a valid approved inventory (`prune.inventory.ts`)
 * is resumable, and a resume deletes only what that inventory approved (F1,
 * owner decision 2026-11-06). The listing diffs the staged tree against it,
 * one to one with the walker's own matcher (R5), and reports where every kept
 * entry is: guidance for the user, not the safety mechanism. A leftover
 * without an inventory is never resumed as a delete.
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.leftovers
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'
import { readStable } from './prune.sidecar.js'
import { parseIntentStrict, parseDeletingStrict, runBindingProblem } from './prune.metadata.js'
import type { DeletingMarker, MetaRecord, PruneIntent } from './prune.metadata.js'
import {
  INVENTORY_FILE,
  INVENTORY_TMP,
  loadInventory,
  parseInventoryStrict,
  stagingMatches,
} from './prune.inventory.js'
import { diffInventory } from './prune.inventory.match.js'
import type { KeptEntry } from './prune.inventory.match.js'
import { META, RANDOM_NAME_RE, resumeStagingProblem } from './prune.walk.shared.js'

/** An intent is well under 2 KiB. */
const INTENT_MAX_BYTES = 16 * 1024

export type LeftoverState =
  | 'staging-unusable'
  | 'empty'
  | 'intent-only'
  | 'partial-intent'
  | 'inventory-partial'
  | 'staged'
  | 'interrupted-delete'
  | 'skeleton'
  | 'finished'
  | 'staged-orphan'
  | 'unknown'

/** A resumable leftover: what a resume job names. */
export interface StagedItem {
  S: string
  stagingRoot: string
  leaf: string
  /** `S/<leaf>`. */
  copyPath: string
  opDir: string
  /** sha256 of the inventory bytes this listing read: the resume job binds to it. */
  inventorySha256: string
  /** Metadata inspected here (stable read, strict schema); removable after a confirmed run only if unchanged. */
  inheritedMeta: Record<string, MetaRecord>
}

export interface Leftover {
  S: string
  state: LeftoverState
  /** Every entry matching no approved row, kept where it is (R5). */
  unapproved: KeptEntry[]
  detail?: string
  intent?: PruneIntent
  leaf?: string
  item?: StagedItem
  /** Approved files and symlinks still present: what a resume would delete. */
  remaining?: { path: string; rel: string }[]
  /** Approved directories left behind; a resume never removes them, so the user may, by hand. */
  skeletons?: string[]
  cleanup?: string[]
  meta?: Record<string, MetaRecord>
}

const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}
const recordOfRead = (rs: { ino: bigint; bytes: Buffer }): MetaRecord => ({
  ino: String(rs.ino),
  bytes: rs.bytes.toString('base64'),
})

/**
 * States: staging-unusable | empty | intent-only | partial-intent |
 * inventory-partial | staged | interrupted-delete | skeleton | finished |
 * staged-orphan | unknown. Only `interrupted-delete` carries an `item`;
 * `cleanup` lists our own metadata to remove, each by its `meta` record.
 */
export function inspectLeftover({ S, stagingRoot }: { S: string; stagingRoot: string }): Leftover {
  const r: Leftover = { S, state: 'unknown', unapproved: [] }
  let names: string[]
  let sStat: BigIntStats
  try {
    const rootDev = fs.lstatSync(stagingRoot, { bigint: true }).dev
    const bad = resumeStagingProblem(S, stagingRoot, rootDev)
    if (bad !== null) return { ...r, state: 'staging-unusable', detail: bad }
    sStat = fs.lstatSync(S, { bigint: true })
    names = fs.readdirSync(S).sort()
  } catch (err) {
    return { ...r, state: 'staging-unusable', detail: `unreadable (${errCode(err)})` }
  }
  // A NAME is not proof. Each metadata file is stable-read and checked against
  // the strict schema here, and its (inode, bytes) recorded in `meta`; cleanup
  // later removes only a file still identical to that record.
  const meta: Record<string, MetaRecord> = {}
  let intent: PruneIntent | null = null
  let marker: DeletingMarker | null = null
  if (names.includes('intent.json')) {
    const rs = readStable(path.join(S, 'intent.json'), { maxBytes: INTENT_MAX_BYTES })
    intent = rs.ok ? parseIntentStrict(rs.bytes) : null
    if (intent === null || !rs.ok) {
      return {
        ...r,
        state: 'unknown',
        detail: "intent.json is not Skillsmith's intent; never touched",
      }
    }
    meta['intent.json'] = recordOfRead(rs)
  }
  if (names.includes('deleting')) {
    const rs = readStable(path.join(S, 'deleting'))
    marker = rs.ok ? parseDeletingStrict(rs.bytes) : null
    if (!rs.ok || marker === null) {
      return {
        ...r,
        state: 'unknown',
        detail: "deleting is not Skillsmith's marker; never touched",
      }
    }
    meta.deleting = recordOfRead(rs)
  }
  // `.m-` names: our metadata caught mid-removal (P4g), ours only if it parses as such.
  const mNames = names.filter((n) => /^\.m-[0-9a-f]{16}$/.test(n))
  for (const n of mNames) {
    const rs = readStable(path.join(S, n), { maxBytes: 32 * 1024 * 1024 })
    const ours =
      rs.ok &&
      (parseDeletingStrict(rs.bytes) !== null ||
        parseIntentStrict(rs.bytes) !== null ||
        parseInventoryStrict(rs.bytes) !== null)
    if (!rs.ok || !ours) {
      return { ...r, state: 'unknown', detail: `${n} is not provably prune's; never touched` }
    }
    meta[n] = recordOfRead(rs)
  }
  r.meta = meta
  const metaPresent = [
    ...mNames,
    ...['deleting', 'intent.json', INVENTORY_FILE].filter((m) => names.includes(m)),
  ]
  if (names.includes(INVENTORY_FILE))
    return withInventory(r, S, stagingRoot, sStat, { intent, marker }, metaPresent)
  return withoutInventory(r, S, names, intent, mNames)
}

/** A leftover with an inventory: the one-to-one diff decides what it is. */
function withInventory(
  r: Leftover,
  S: string,
  stagingRoot: string,
  sStat: BigIntStats,
  run: { intent: PruneIntent | null; marker: DeletingMarker | null },
  metaPresent: string[]
): Leftover {
  const { intent, marker } = run
  const ld = loadInventory(S)
  if (!ld.ok) return { ...r, state: 'unknown', detail: `${ld.why}; never touched` }
  if (!stagingMatches(ld.inv.staging, sStat)) {
    return {
      ...r,
      state: 'unknown',
      detail: 'S is not the staging directory its inventory recorded',
    }
  }
  if (intent !== null && intent.leaf !== ld.inv.leaf) {
    return { ...r, state: 'unknown', intent, detail: 'the intent and the inventory disagree' }
  }
  ;(r.meta as Record<string, MetaRecord>)[INVENTORY_FILE] = ld.record
  let diff
  try {
    diff = diffInventory(S, ld.inv)
  } catch (err) {
    return { ...r, state: 'unknown', detail: `the staged tree could not be read (${errCode(err)})` }
  }
  const leaf = ld.inv.leaf
  const base = { ...r, intent: intent ?? undefined, leaf, unapproved: diff.unapproved }
  if (diff.remaining.length > 0) {
    // A resume only for one run's intent, marker and inventory (owner decision 2026-11-07).
    const unbound = runBindingProblem({ intent, marker, inv: ld.inv, digest: ld.digest })
    if (unbound !== null && intent !== null && marker === null) {
      return {
        ...base,
        state: 'staged',
        remaining: diff.remaining,
        detail:
          'the inventory was written but the delete never started (no deleting marker): ' +
          'nothing was deleted; restore the copy instead',
      }
    }
    if (unbound !== null) return { ...base, state: 'unknown', detail: `${unbound}; never touched` }
    const meta = r.meta as Record<string, MetaRecord>
    return {
      ...base,
      state: 'interrupted-delete',
      remaining: diff.remaining,
      item: {
        S,
        stagingRoot,
        leaf,
        copyPath: path.join(S, leaf),
        opDir: intent !== null ? path.dirname(intent.copyPath) : S,
        inventorySha256: ld.digest,
        inheritedMeta: Object.fromEntries(
          Object.entries(meta).filter(([k]) => k === 'intent.json' || k === 'deleting')
        ),
      },
    }
  }
  if (diff.dirs.length > 0) {
    return {
      ...base,
      state: 'skeleton',
      skeletons: diff.dirs.map((d) => d.path),
      detail:
        'every approved file is gone; the approved directories left are not removed by a resume. ' +
        'Remove them by hand.',
    }
  }
  // Nothing approved is left. An unapproved entry stays, and so does the inventory beside it.
  if (diff.unapproved.length > 0) {
    return {
      ...base,
      state: 'finished',
      cleanup: metaPresent.filter((m) => m !== INVENTORY_FILE),
      detail: 'unapproved entries are left where they are; the inventory stays beside them',
    }
  }
  return { ...base, state: 'finished', cleanup: metaPresent }
}

/** A leftover without an inventory: never resumed as a delete. */
function withoutInventory(
  r: Leftover,
  S: string,
  names: string[],
  intent: PruneIntent | null,
  mNames: string[]
): Leftover {
  if (names.includes(INVENTORY_TMP)) {
    return {
      ...r,
      state: 'inventory-partial',
      intent: intent ?? undefined,
      detail: 'the inventory was never completed, so nothing is deleted; restore the copy instead',
    }
  }
  const trees = names.filter((n) => !META.has(n) && !RANDOM_NAME_RE.test(n))
  const randoms = names.filter((n) => RANDOM_NAME_RE.test(n) && !mNames.includes(n))
  if (names.length === 0) return { ...r, state: 'empty', cleanup: [] }
  if (names.includes('intent.json.tmp')) return partialIntent(r, S, names)
  if (randoms.length > 0) {
    return {
      ...r,
      state: 'unknown',
      intent: intent ?? undefined,
      detail: 'random names without an inventory',
    }
  }
  if (intent === null) {
    if (trees.length === 1 && mNames.length === 0) {
      return {
        ...r,
        state: 'staged-orphan',
        leaf: trees[0],
        detail: 'no intent and no inventory: nothing is deleted; restore it by hand',
      }
    }
    return {
      ...r,
      state: 'unknown',
      detail: `entries ${names.join(',')} without an intent; never touched`,
    }
  }
  if (trees.some((n) => n !== intent.leaf)) {
    return {
      ...r,
      state: 'unknown',
      intent,
      detail: 'entries do not match the intent; never touched',
    }
  }
  const deleting = names.includes('deleting')
  if (trees.length === 1) {
    if (deleting) {
      return {
        ...r,
        state: 'unknown',
        intent,
        detail: 'a delete marker without an inventory; never touched',
      }
    }
    return {
      ...r,
      state: 'staged',
      intent,
      leaf: intent.leaf,
      detail:
        'staged before its inventory was written: nothing is deleted; restore the copy instead',
    }
  }
  if (names.includes('sidecar.json')) {
    return {
      ...r,
      state: 'unknown',
      intent,
      detail: 'a staged sidecar without its copy; never touched',
    }
  }
  const cleanup = [...mNames, ...['deleting', 'intent.json'].filter((m) => names.includes(m))]
  // P4g removes `deleting`, then the intent, then the inventory: an intent with the
  // copy still at its original path means it was never moved.
  if (!deleting && mNames.length === 0 && exists(intent.copyPath)) {
    return { ...r, state: 'intent-only', intent, cleanup: ['intent.json'] }
  }
  return { ...r, state: 'finished', intent, cleanup }
}

/**
 * `intent.json.tmp`: a run stopped after writing its intent's temp and before
 * renaming it into place, so the copy was never moved. Removable only when the
 * temp is a complete, strict-schema intent and nothing else is in `S`;
 * otherwise it is reported, not `unknown`, and is never touched.
 */
function partialIntent(r: Leftover, S: string, names: string[]): Leftover {
  if (names.length !== 1) {
    return { ...r, state: 'unknown', detail: `entries ${names.join(',')} beside an intent temp` }
  }
  const rs = readStable(path.join(S, 'intent.json.tmp'), { maxBytes: INTENT_MAX_BYTES })
  const intent = rs.ok ? parseIntentStrict(rs.bytes) : null
  if (!rs.ok || intent === null) {
    return {
      ...r,
      state: 'partial-intent',
      cleanup: [],
      detail:
        'an incomplete intent temp; the copy was never moved. It is not removed automatically, ' +
        "because its bytes cannot be proven to be Skillsmith's",
    }
  }
  const meta = { ...(r.meta ?? {}), 'intent.json.tmp': recordOfRead(rs) }
  return { ...r, state: 'partial-intent', intent, meta, cleanup: ['intent.json.tmp'] }
}

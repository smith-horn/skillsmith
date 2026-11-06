/**
 * SMI-6531 (A1 step 6c-i): what a `.prune-*` staging leftover is, read-only
 * (ADR-166 D-11 "Crash recovery"), ported from the SMI-6676 spike's
 * `prune.leftovers.mjs`. Prune's listing acts on the result and doctor reuses
 * it; neither is wired yet (6c-ii, 6c-iii).
 *
 * A leftover with a misplaced entry still present is `misplaced-pending` and
 * offers no resume (F1, owner decision 2026-11-06): a misplaced entry is never
 * deleted, so the user moves it out by hand first (`prune.misplaced.ts`).
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.leftovers
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCode } from './park-result.js'
import { readStable } from './prune.sidecar.js'
import { parseIntentStrict, parseDeletingStrict } from './prune.metadata.js'
import type { MetaRecord, PruneIntent } from './prune.metadata.js'
import { isMisplacedRecordName, misplacedState } from './prune.misplaced.js'
import type { MisplacedEntry } from './prune.misplaced.js'
import { META, RANDOM_NAME_RE, resumeStagingProblem } from './prune.walk.shared.js'

/** An intent is well under 2 KiB. */
const INTENT_MAX_BYTES = 16 * 1024

export type LeftoverState =
  | 'staging-unusable'
  | 'misplaced-pending'
  | 'empty'
  | 'intent-only'
  | 'partial-intent'
  | 'staged'
  | 'interrupted-delete'
  | 'finished'
  | 'staged-orphan'
  | 'unknown'

/** A staged copy the listing can classify, and the walker can resume at `S`. */
export interface StagedItem {
  root: null
  stagingRoot: string
  opId: string | null
  opDir: string
  name: string
  copyPath: string
  sidecarPath: string | null
  staged: true
  S: string
  interruptedDelete: boolean
  /** Metadata inspected here (stable read, strict schema); removable after a confirmed run only if unchanged. */
  inheritedMeta: Record<string, MetaRecord>
  /** The pre-staging paths the sidecar names, so its schema is checked against them. */
  schemaCopyPath?: string
  schemaOpDir?: string
}

export interface Leftover {
  S: string
  state: LeftoverState
  /** Every misplaced entry a record in `S` names. */
  misplaced: MisplacedEntry[]
  detail?: string
  intent?: PruneIntent
  leaf?: string
  item?: StagedItem
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
const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')
const recordOfRead = (rs: { ino: bigint; bytes: Buffer }): MetaRecord => ({
  ino: String(rs.ino),
  bytes: rs.bytes.toString('base64'),
})

/**
 * States: staging-unusable | misplaced-pending | empty | intent-only |
 * partial-intent | staged | interrupted-delete | finished | staged-orphan |
 * unknown. `item` is a resumable copy descriptor for the three tree-bearing
 * states; `cleanup` lists our own metadata to remove, each by its `meta` record.
 */
export function inspectLeftover({ S, stagingRoot }: { S: string; stagingRoot: string }): Leftover {
  const r: Leftover = { S, state: 'unknown', misplaced: [] }
  let rootDev: bigint
  let names: string[]
  try {
    rootDev = fs.lstatSync(stagingRoot, { bigint: true }).dev
    const bad = resumeStagingProblem(S, stagingRoot, rootDev)
    if (bad !== null) return { ...r, state: 'staging-unusable', detail: bad }
    names = fs.readdirSync(S).sort()
  } catch (err) {
    return { ...r, state: 'staging-unusable', detail: `unreadable (${errCode(err)})` }
  }
  const mp = misplacedState(S, names)
  r.misplaced = mp.entries
  if (mp.blocking.length > 0) {
    return {
      ...r,
      state: 'misplaced-pending',
      detail: `not resumable until each misplaced entry is moved out by hand: ${mp.blocking.join('; ')}`,
    }
  }
  // A NAME is not proof. Each metadata file is stable-read and checked against
  // the strict schema here, and its (inode, bytes) recorded in `meta`; cleanup
  // later removes only a file still identical to that record. A file that is
  // not Skillsmith's exact schema makes the leftover `unknown`.
  const meta: Record<string, MetaRecord> = { ...mp.cleared }
  const records = Object.keys(mp.cleared)
  const rest = names.filter((n) => !isMisplacedRecordName(n))
  let intent: PruneIntent | null = null
  if (rest.includes('intent.json')) {
    const rs = readStable(path.join(S, 'intent.json'), { maxBytes: INTENT_MAX_BYTES })
    intent = rs.ok ? parseIntentStrict(rs.bytes) : null
    if (intent === null || !rs.ok) {
      return {
        ...r,
        state: 'unknown',
        detail: "intent.json is unreadable or not Skillsmith's intent schema; never touched",
      }
    }
    meta['intent.json'] = recordOfRead(rs)
  }
  if (rest.includes('deleting')) {
    const rs = readStable(path.join(S, 'deleting'))
    if (!rs.ok || parseDeletingStrict(rs.bytes) === null) {
      return {
        ...r,
        state: 'unknown',
        detail: "deleting is unreadable or not Skillsmith's marker; never touched",
      }
    }
    meta.deleting = recordOfRead(rs)
  }
  r.meta = meta
  // Prune's own random names are never a tree, so never a staged orphan (F6).
  const randoms = rest.filter((n) => RANDOM_NAME_RE.test(n))
  const trees = rest.filter((n) => !META.has(n) && !RANDOM_NAME_RE.test(n))
  const deleting = rest.includes('deleting')
  const done = (cleanup: string[]): Leftover => ({
    ...r,
    state: 'finished',
    intent: intent ?? undefined,
    cleanup: [...cleanup, ...records],
  })
  if (rest.length === 0) return { ...r, state: 'empty', cleanup: records }
  if (rest.includes('intent.json.tmp')) return partialIntent(r, S, rest, meta, records)
  if (intent === null) {
    if (trees.length === 1 && randoms.length === 0) {
      const leaf = trees[0] as string
      return { ...r, state: 'staged-orphan', leaf, item: stagedItem(S, leaf, null, false, meta) }
    }
    return {
      ...r,
      state: 'unknown',
      detail: `entries ${rest.join(',')} without an intent; never touched`,
    }
  }
  const leaf = intent.leaf
  if (trees.some((n) => n !== leaf)) {
    return {
      ...r,
      state: 'unknown',
      intent,
      detail: 'entries do not match the intent; never touched',
    }
  }
  const hasLeaf = trees.length === 1
  if (randoms.length > 0) {
    // P4f's sidecar (`.d-`) or P4g's metadata (`.m-`) caught mid-removal: the
    // tree is already gone. Each is ours only if it is provably what it was.
    if (hasLeaf) return { ...r, state: 'unknown', intent, detail: 'a random name beside the tree' }
    for (const n of randoms) {
      const rs = readStable(path.join(S, n), { maxBytes: INTENT_MAX_BYTES })
      const ours =
        rs.ok &&
        (n.startsWith('.d-')
          ? sha256(rs.bytes) === intent.approvedSidecarSha256
          : parseDeletingStrict(rs.bytes) !== null || parseIntentStrict(rs.bytes) !== null)
      if (!rs.ok || !ours) {
        return {
          ...r,
          state: 'unknown',
          intent,
          detail: `${n} is not provably prune's; never touched`,
        }
      }
      meta[n] = recordOfRead(rs)
    }
  }
  const hasSidecar = rest.includes('sidecar.json')
  if (!hasLeaf && !hasSidecar && !deleting) {
    // P4g removes `deleting` before `intent.json`, so an intent alone means
    // "never moved" only while the copy is still at its original path.
    if (exists(intent.copyPath))
      return { ...r, state: 'intent-only', intent, cleanup: ['intent.json', ...records] }
    return done([...randoms, 'intent.json'])
  }
  if (!hasLeaf && !hasSidecar) return done([...randoms, 'intent.json', 'deleting'])
  if (!hasLeaf && deleting) {
    // The tree is gone and the sidecar, deleted last, is not yet. It is ours
    // to remove only if it is the sidecar the intent approved, byte for byte.
    const rs = readStable(path.join(S, 'sidecar.json'))
    if (!rs.ok || sha256(rs.bytes) !== intent.approvedSidecarSha256) {
      return {
        ...r,
        state: 'unknown',
        intent,
        detail: 'a staged sidecar that is not the approved one, without its copy; never touched',
      }
    }
    meta['sidecar.json'] = recordOfRead(rs)
    return done(['sidecar.json', ...randoms, 'intent.json', 'deleting'])
  }
  if (hasLeaf) {
    return {
      ...r,
      state: deleting ? 'interrupted-delete' : 'staged',
      intent,
      leaf,
      item: stagedItem(S, leaf, intent, deleting, meta),
    }
  }
  return {
    ...r,
    state: 'unknown',
    intent,
    detail: 'a staged sidecar without its copy; never touched',
  }
}

/**
 * The resumable item. A staged `S/sidecar.json` is offered as the copy's
 * sidecar only if it is the one the intent approved (its sha256): a sidecar
 * swapped in before staging is left for the user, never deleted as approved.
 */
function stagedItem(
  S: string,
  leaf: string,
  intent: PruneIntent | null,
  interruptedDelete: boolean,
  meta: Record<string, MetaRecord>
): StagedItem {
  const stagedSidecar = path.join(S, 'sidecar.json')
  const oldSidecar = intent?.sidecarPath ?? null
  let sidecarPath: string | null = null
  if (exists(stagedSidecar)) {
    const rs = readStable(stagedSidecar)
    const approved = intent === null || (rs.ok && sha256(rs.bytes) === intent.approvedSidecarSha256)
    sidecarPath = approved ? stagedSidecar : null
  } else if (oldSidecar !== null && exists(oldSidecar)) sidecarPath = oldSidecar
  const copyPath = path.join(S, leaf)
  const origCopy = intent?.copyPath ?? null
  return {
    root: null,
    stagingRoot: path.dirname(S),
    opId: origCopy ? path.basename(path.dirname(origCopy)) : null,
    opDir: origCopy ? path.dirname(origCopy) : S,
    name: leaf,
    copyPath,
    sidecarPath,
    staged: true,
    S,
    interruptedDelete,
    inheritedMeta: Object.fromEntries(
      Object.entries(meta).filter(([k]) => k === 'intent.json' || k === 'deleting')
    ),
    ...(origCopy ? { schemaCopyPath: origCopy, schemaOpDir: path.dirname(origCopy) } : {}),
  }
}

/**
 * `intent.json.tmp`: a run stopped after writing its intent's temp and before
 * renaming it into place, so the copy was never moved (the rename into
 * staging comes after). Removable only when the temp is a complete,
 * strict-schema intent and nothing else is in `S`; otherwise it is reported,
 * not `unknown`, and is never touched.
 */
function partialIntent(
  r: Leftover,
  S: string,
  rest: string[],
  meta: Record<string, MetaRecord>,
  records: string[]
): Leftover {
  if (rest.length !== 1) {
    return { ...r, state: 'unknown', detail: `entries ${rest.join(',')} beside an intent temp` }
  }
  const rs = readStable(path.join(S, 'intent.json.tmp'), { maxBytes: INTENT_MAX_BYTES })
  const intent = rs.ok ? parseIntentStrict(rs.bytes) : null
  if (!rs.ok || intent === null) {
    return {
      ...r,
      state: 'partial-intent',
      cleanup: records,
      detail:
        'an incomplete intent temp; the copy was never moved. It is not removed automatically, ' +
        "because its bytes cannot be proven to be Skillsmith's",
    }
  }
  meta['intent.json.tmp'] = recordOfRead(rs)
  return { ...r, state: 'partial-intent', intent, meta, cleanup: ['intent.json.tmp', ...records] }
}

/**
 * SMI-6531 (A1 step 6c-i): what a `.prune-*` staging leftover is, read-only
 * (ADR-166 D-11 "Crash recovery"), ported from the SMI-6676 spike's
 * `prune.leftovers.mjs`. Prune's listing acts on the result and doctor reuses
 * it; neither is wired yet (6c-ii, 6c-iii).
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
import { META, resumeStagingProblem } from './prune.walk.shared.js'

/** `misplaced.json` is a few hundred bytes; anything past this is not ours. */
const MISPLACED_MAX_BYTES = 64 * 1024
/** An intent is well under 2 KiB. */
const INTENT_MAX_BYTES = 16 * 1024

export type LeftoverState =
  | 'staging-unusable'
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
  misplaced: unknown
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

/**
 * States: staging-unusable | empty | intent-only | staged | interrupted-delete
 * | finished | staged-orphan | unknown. `item` is a classifiable copy
 * descriptor for the three tree-bearing states; `cleanup` lists our own
 * metadata to remove.
 */
export function inspectLeftover({ S, stagingRoot }: { S: string; stagingRoot: string }): Leftover {
  const r: Leftover = { S, state: 'unknown', misplaced: null }
  let rootDev: bigint
  try {
    rootDev = fs.lstatSync(stagingRoot, { bigint: true }).dev
  } catch (err) {
    return { ...r, state: 'staging-unusable', detail: `unreadable (${errCode(err)})` }
  }
  const bad = resumeStagingProblem(S, stagingRoot, rootDev)
  if (bad !== null) return { ...r, state: 'staging-unusable', detail: bad }

  const names = fs.readdirSync(S).sort()
  const mp = path.join(S, 'misplaced.json')
  if (names.includes('misplaced.json')) {
    // Stable, no-follow and capped: a planted link or a huge file is reported, never read.
    const rs = readStable(mp, { maxBytes: MISPLACED_MAX_BYTES })
    try {
      r.misplaced = rs.ok ? JSON.parse(rs.bytes.toString('utf8')) : { unreadable: true, path: mp }
    } catch {
      r.misplaced = { unreadable: true, path: mp }
    }
  }
  // A NAME is not proof. Each metadata file is stable-read and checked against
  // the strict schema here, and its (inode, bytes) recorded in `meta`; cleanup
  // later removes only a file still identical to that record. A file that is
  // not Skillsmith's exact schema makes the leftover `unknown`.
  const meta: Record<string, MetaRecord> = {}
  let intent: PruneIntent | null = null
  if (names.includes('intent.json')) {
    const rs = readStable(path.join(S, 'intent.json'), { maxBytes: INTENT_MAX_BYTES })
    intent = rs.ok ? parseIntentStrict(rs.bytes) : null
    if (intent === null || !rs.ok) {
      return {
        ...r,
        state: 'unknown',
        detail: "intent.json is unreadable or not Skillsmith's intent schema; never touched",
      }
    }
    meta['intent.json'] = { ino: String(rs.ino), bytes: rs.bytes.toString('base64') }
  }
  if (names.includes('deleting')) {
    const rs = readStable(path.join(S, 'deleting'))
    if (!rs.ok || parseDeletingStrict(rs.bytes) === null) {
      return {
        ...r,
        state: 'unknown',
        detail: "deleting is unreadable or not Skillsmith's marker; never touched",
      }
    }
    meta.deleting = { ino: String(rs.ino), bytes: rs.bytes.toString('base64') }
  }
  r.meta = meta
  const trees = names.filter((n) => !META.has(n))
  const deleting = names.includes('deleting')
  if (names.length === 0) return { ...r, state: 'empty', cleanup: [] }
  if (names.includes('intent.json.tmp')) return partialIntent(r, S, names, meta)
  if (intent === null) {
    if (trees.length === 1) {
      const leaf = trees[0] as string
      return {
        ...r,
        state: 'staged-orphan',
        leaf,
        item: stagedItem(S, leaf, null, false, meta),
      }
    }
    return {
      ...r,
      state: 'unknown',
      detail: `entries ${names.join(',')} without an intent; never touched`,
    }
  }
  const leaf = intent.leaf
  if (typeof leaf !== 'string' || trees.some((n) => n !== leaf)) {
    return {
      ...r,
      state: 'unknown',
      intent,
      detail: 'entries do not match the intent; never touched',
    }
  }
  const hasLeaf = trees.length === 1
  const hasSidecar = names.includes('sidecar.json')
  if (!hasLeaf && !deleting && !hasSidecar) {
    return { ...r, state: 'intent-only', intent, cleanup: ['intent.json'] }
  }
  if (!hasLeaf && deleting && !hasSidecar) {
    return {
      ...r,
      state: 'finished',
      intent,
      cleanup: r.misplaced ? [] : ['intent.json', 'deleting'],
    }
  }
  if (!hasLeaf && deleting && hasSidecar) {
    // The tree is gone and the sidecar, deleted last, is not yet. It is ours
    // to remove only if it is the sidecar the intent approved, byte for byte.
    const rs = readStable(path.join(S, 'sidecar.json'))
    const sha = rs.ok ? crypto.createHash('sha256').update(rs.bytes).digest('hex') : null
    if (!rs.ok || sha === null || sha !== intent.approvedSidecarSha256) {
      return {
        ...r,
        state: 'unknown',
        intent,
        detail: 'a staged sidecar that is not the approved one, without its copy; never touched',
      }
    }
    meta['sidecar.json'] = { ino: String(rs.ino), bytes: rs.bytes.toString('base64') }
    return {
      ...r,
      state: 'finished',
      intent,
      cleanup: r.misplaced ? [] : ['sidecar.json', 'intent.json', 'deleting'],
    }
  }
  if (hasLeaf && deleting) {
    return {
      ...r,
      state: 'interrupted-delete',
      intent,
      leaf,
      item: stagedItem(S, leaf, intent, true, meta),
    }
  }
  if (hasLeaf) {
    return { ...r, state: 'staged', intent, leaf, item: stagedItem(S, leaf, intent, false, meta) }
  }
  return {
    ...r,
    state: 'unknown',
    intent,
    detail: 'a staged sidecar without its copy; never touched',
  }
}

function stagedItem(
  S: string,
  leaf: string,
  intent: PruneIntent | null,
  interruptedDelete: boolean,
  meta: Record<string, MetaRecord>
): StagedItem {
  const stagedSidecar = path.join(S, 'sidecar.json')
  const oldSidecar = intent?.sidecarPath ?? null
  const sidecarPath = exists(stagedSidecar)
    ? stagedSidecar
    : oldSidecar !== null && exists(oldSidecar)
      ? oldSidecar
      : null
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
    inheritedMeta: meta,
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
  names: string[],
  meta: Record<string, MetaRecord>
): Leftover {
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
  meta['intent.json.tmp'] = { ino: String(rs.ino), bytes: rs.bytes.toString('base64') }
  return { ...r, state: 'partial-intent', intent, meta, cleanup: ['intent.json.tmp'] }
}

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
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'
import { readStable } from './prune.sidecar.js'
import { parseIntentStrict, parseDeletingStrict } from './prune.metadata.js'
import type { MetaRecord, PruneIntent } from './prune.metadata.js'
import { META, stagingProblem } from './prune.walk.shared.js'

export type LeftoverState =
  | 'staging-unusable'
  | 'empty'
  | 'intent-only'
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
  let sd: BigIntStats
  let td: BigIntStats
  try {
    sd = fs.lstatSync(S, { bigint: true })
    td = fs.lstatSync(stagingRoot, { bigint: true })
  } catch (err) {
    return { ...r, state: 'staging-unusable', detail: `unreadable (${errCode(err)})` }
  }
  const bad = stagingProblem(sd, td.dev)
  if (bad !== null) return { ...r, state: 'staging-unusable', detail: bad }

  const names = fs.readdirSync(S).sort()
  const mp = path.join(S, 'misplaced.json')
  if (names.includes('misplaced.json')) {
    try {
      r.misplaced = JSON.parse(fs.readFileSync(mp, 'utf8'))
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
    const rs = readStable(path.join(S, 'intent.json'))
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

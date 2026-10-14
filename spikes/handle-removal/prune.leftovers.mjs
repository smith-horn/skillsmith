// SMI-7123 Wave 5 (design §4): what a `.prune-*` staging leftover is, read-only.
// prune.mjs acts on the result; doctor reuses the same listing.
//
// fs is the DEFAULT export, looked up at call time.

import fs from 'node:fs'
import path from 'node:path'
import { readStable } from './prune.sidecar.mjs'

const SELF_UID = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
const META = new Set(['intent.json', 'deleting', 'sidecar.json', 'misplaced.json'])

const exists = (p) => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * @returns {{state:string, S:string, detail?:string, intent?:object, leaf?:string,
 *            item?:object, misplaced?:object|null, cleanup?:string[]}}
 * States (§4): staging-unusable | empty | intent-only | staged | interrupted-delete |
 * finished | staged-orphan | unknown. `item` is a classifiable copy descriptor
 * for the three tree-bearing states; `cleanup` lists our own metadata to remove.
 */
export function inspectLeftover({ S, trashRoot }) {
  const r = { S, state: 'unknown', misplaced: null }
  let sd
  let td
  try {
    sd = fs.lstatSync(S, { bigint: true })
    td = fs.lstatSync(trashRoot, { bigint: true })
  } catch (err) {
    return { ...r, state: 'staging-unusable', detail: `unreadable (${err.code})` }
  }
  const bad =
    sd.isSymbolicLink() || !sd.isDirectory()
      ? 'not a directory'
      : SELF_UID !== null && sd.uid !== SELF_UID
        ? 'owned by another user'
        : (sd.mode & 0o077n) !== 0n
          ? `mode ${(sd.mode & 0o777n).toString(8)}`
          : sd.dev !== td.dev
            ? 'on another device'
            : null
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
  let intent = null
  if (names.includes('intent.json')) {
    const rs = readStable(path.join(S, 'intent.json'))
    try {
      intent = rs.ok ? JSON.parse(rs.bytes.toString('utf8')) : null
    } catch {
      intent = null
    }
    if (intent === null)
      return { ...r, state: 'unknown', detail: 'intent.json unreadable; never touched' }
  }
  const trees = names.filter((n) => !META.has(n))
  const deleting = names.includes('deleting')
  if (names.length === 0) return { ...r, state: 'empty', cleanup: [] }
  if (intent === null) {
    if (trees.length === 1) {
      return { ...r, state: 'staged-orphan', leaf: trees[0], item: stagedItem(S, trees[0], null) }
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
  if (!hasLeaf && !deleting && !hasSidecar)
    return { ...r, state: 'intent-only', intent, cleanup: ['intent.json'] }
  if (!hasLeaf && deleting && !hasSidecar) {
    return {
      ...r,
      state: 'finished',
      intent,
      cleanup: r.misplaced ? [] : ['intent.json', 'deleting'],
    }
  }
  if (hasLeaf && deleting)
    return {
      ...r,
      state: 'interrupted-delete',
      intent,
      leaf,
      item: stagedItem(S, leaf, intent, true),
    }
  if (hasLeaf) return { ...r, state: 'staged', intent, leaf, item: stagedItem(S, leaf, intent) }
  return {
    ...r,
    state: 'unknown',
    intent,
    detail: 'a staged sidecar without its copy; never touched',
  }
}

function stagedItem(S, leaf, intent, interruptedDelete = false) {
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
    trashRoot: path.dirname(S),
    opId: origCopy ? path.basename(path.dirname(origCopy)) : null,
    opDir: origCopy ? path.dirname(origCopy) : S,
    name: leaf,
    copyPath,
    sidecarPath,
    staged: true,
    S,
    interruptedDelete,
    ...(origCopy ? { schemaCopyPath: origCopy, schemaOpDir: path.dirname(origCopy) } : {}),
  }
}

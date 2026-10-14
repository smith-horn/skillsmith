#!/usr/bin/env node
// SMI-7123 Wave 5, Sol code round 1 finding 2: metadata cleanup must not trust names.
// Rule (coordinator, 2026-10-14): nothing is deleted without confirmation, anywhere.
//
// DECLARED FAILURES ON THE PRE-FIX CODE (each a file that must survive is deleted):
//  a1 Sol's input: a user-owned 0700 .prune-x/ holding only a parseable intent.json is
//     unlinked by --apply with NO confirmation (cleanLeftover ran before any prompt).
//  a2 ...and with a batch yes, although its content is not Skillsmith's intent schema.
//  b1 a genuine intent-only leftover is cleaned although the batch answer was no.
//  c  a genuine leftover whose intent.json is REPLACED between inspection and cleanup
//     (new inode, valid-looking intent with another pruneId) is unlinked.
//  d  post-walk: an intent.json replaced (new inode) before P4g's unlinks is unlinked.
//  e  post-walk: `deleting` rewritten in place after the walk is unlinked.
import fs from 'node:fs'
import path from 'node:path'
import { makeCheck, rmFixture } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import { walkerOpts } from './w5-variant.mjs'
import { prune } from '../prune.mjs'

const { check, done } = makeCheck('[w5-metadata]')
const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${err.code}`
  }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stagings = (t) =>
  fs
    .readdirSync(t)
    .filter((n) => n.startsWith('.prune-'))
    .map((n) => path.join(t, n))

// --- a: Sol's user-owned .prune-x/intent.json ----------------------------------------
for (const [label, answer] of [
  ['a1 no confirmation', false],
  ['a2 batch yes, not our schema', true],
]) {
  const f = makeParent('w5-md-a-')
  try {
    const trash = path.join(f.parent, '.skillsmith-trash')
    fs.mkdirSync(trash)
    const S = path.join(trash, '.prune-x')
    fs.mkdirSync(S, { mode: 0o700 })
    const user = JSON.stringify({ leaf: 'notes', mine: true })
    fs.writeFileSync(path.join(S, 'intent.json'), user)
    const r = prune({ roots: [f.parent], apply: true, confirmBatch: () => answer })
    check(`${label}: the user's intent.json survives`, read(path.join(S, 'intent.json')), user)
    // Not Skillsmith's schema: listed, never offered for cleanup.
    const listed = (r.plan.leftovers ?? []).find((l) => l.S === S)
    check(`${label}: it is reported as an unknown leftover`, listed?.state, 'unknown')
  } finally {
    rmFixture(f.root)
  }
}

/** A genuine intent-only leftover: the walker is killed right after P4c (intent written). */
function crashAfterIntent(f) {
  const c = park(f.parent, 'k', 'Q')
  prune({
    roots: [f.parent],
    apply: true,
    confirmBatch: () => true,
    walker: walkerOpts({
      hooks: [
        { when: 'after', fn: 'writeFileSync', a0Re: 'intent\\.json$', action: { kind: 'kill' } },
      ],
    }),
  })
  const S = stagings(c.trashRoot)[0]
  return { c, S, intent: path.join(S, 'intent.json') }
}

// --- b: a genuine leftover is cleaned only with confirmation -------------------------
{
  const f = makeParent('w5-md-b-')
  try {
    const { S, intent } = crashAfterIntent(f)
    const bytes = read(intent)
    check('b premise: a genuine intent-only leftover exists', bytes.startsWith('{'), true)
    prune({ roots: [f.parent], apply: true, confirmBatch: () => false })
    check('b1 a batch no leaves the genuine metadata', read(intent), bytes)
    prune({ roots: [f.parent], apply: true, confirmBatch: () => true })
    check('b2 control: a batch yes removes it and its staging dir', fs.existsSync(S), false)
  } finally {
    rmFixture(f.root)
  }
}

// --- c: replaced between inspection and cleanup -----------------------------------
{
  const f = makeParent('w5-md-c-')
  try {
    const { intent } = crashAfterIntent(f)
    const genuine = JSON.parse(read(intent))
    const swapped = JSON.stringify({ ...genuine, pruneId: 'ffffffffffffffff' }, null, 2)
    let swappedIn = false
    prune({
      roots: [f.parent],
      apply: true,
      confirmBatch: () => {
        // Inspection is done; the cleanup must not have run yet. (On code that
        // cleans before asking, the genuine file is already gone here.)
        if (fs.existsSync(intent)) {
          fs.renameSync(intent, path.join(f.root, 'genuine-intent.json'))
          fs.writeFileSync(intent, swapped)
          swappedIn = true
        }
        return true
      },
    })
    check('c premise: the metadata still existed when confirmation was asked', swappedIn, true)
    check(
      'c the replacement (valid-looking, new inode) survives the cleanup',
      read(intent),
      swapped
    )
  } finally {
    rmFixture(f.root)
  }
}

// --- d / e: post-walk cleanup of what the walker itself wrote --------------------------
for (const [label, mkHook, name, data] of [
  [
    'd intent.json replaced before P4g',
    (c, f) => ({
      when: 'before',
      fn: 'unlinkSync',
      a0Re: '/deleting$',
      action: {
        kind: 'replaceSibling',
        name: 'intent.json',
        data: 'user-bytes-at-intent',
        awayDir: f.root,
      },
    }),
    'intent.json',
    'user-bytes-at-intent',
  ],
  [
    'e deleting rewritten in place after the walk',
    (c) => ({
      when: 'after',
      fn: 'rmdirSync',
      a0Re: `^${esc(c.name)}$`,
      action: { kind: 'writeRel', name: 'deleting', data: 'user-rewrote-deleting' },
    }),
    'deleting',
    'user-rewrote-deleting',
  ],
]) {
  const f = makeParent('w5-md-de-')
  try {
    const c = park(f.parent, 'w', 'Q')
    const r = prune({
      roots: [f.parent],
      apply: true,
      confirmBatch: () => true,
      walker: walkerOpts({ hooks: [mkHook(c, f)] }),
    })
    const item = r.items[0] ?? {}
    const S = stagings(c.trashRoot)[0] ?? '/nonexistent'
    check(`${label}: the copy was still removed`, item.status, 'removed')
    check(`${label}: the replaced ${name} survives`, read(path.join(S, name)), data)
    check(
      `${label}: and is reported`,
      JSON.stringify(item.metadataKept ?? null).includes(name),
      true
    )
  } finally {
    rmFixture(f.root)
  }
}

// --- control: a clean prune leaves no metadata behind ------------------------------
{
  const f = makeParent('w5-md-ok-')
  try {
    const c = park(f.parent, 'ok', 'Q')
    const r = prune({ roots: [f.parent], apply: true, confirmBatch: () => true })
    check('control: removed', r.items[0]?.status, 'removed')
    check('control: no staging directory left', stagings(c.trashRoot).length, 0)
  } finally {
    rmFixture(f.root)
  }
}

done()

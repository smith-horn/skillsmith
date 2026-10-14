#!/usr/bin/env node
// SMI-7123 Wave 5 (design §5, §6 Q8-Q10): the parked index, the quarantine's
// indexPath option, the .gitignore suggestion and the trash report.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeCheck, rmFixture } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import {
  appendParkedIndex,
  readParkedIndex,
  compactParkedIndex,
  gitignoreSuggestion,
} from '../trash-index.mjs'
import { listTrash, formatTrashReport } from '../prune.classify.mjs'

const { check, done } = makeCheck('[w5-index]')

// quarantine appends one line per park; a failure is indexError, status unchanged
{
  const f = makeParent('w5-idx-')
  try {
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const a = park(f.parent, 'a', 'Q', { indexPath })
    const idx = readParkedIndex(indexPath)
    check('index: one line after one park', idx.entries.length, 1)
    check('index: it names the copy path', idx.entries[0].path, a.copyPath)
    check('index: and the opId', idx.entries[0].opId, a.opId)
    const { quarantineTree, computePathTreeHash } = await import('../quarantine.mjs')
    const { buildTree } = await import('./w5-fixtures.mjs')
    buildTree(f.parent, 'b')
    const badIndex = path.join(f.root, 'no-such-dir', 'idx.jsonl')
    const r = quarantineTree(f.parent, 'b', {
      guardHash: computePathTreeHash(path.join(f.parent, 'b')).treeHash,
      indexPath: badIndex,
    })
    check('index: an unwritable index leaves the status quarantined', r.status, 'quarantined')
    check('index: and is reported as indexError', r.indexError, 'ENOENT')
  } finally {
    rmFixture(f.root)
  }
}

// Q8: (a) a copy with no line is index:missing; (b) a stale line is no error and compaction drops it
{
  const f = makeParent('w5-q8-')
  try {
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const a = park(f.parent, 'a', 'Q', { indexPath })
    const b = park(f.parent, 'b', 'Q', { indexPath })
    const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean)
    fs.writeFileSync(indexPath, lines.filter((l) => !l.includes(a.copyPath)).join('\n') + '\n')
    fs.rmSync(b.copyPath, { recursive: true })
    const l = listTrash({ roots: [f.parent], indexPath })
    check(
      'Q8a: the line-less copy is listed as index:missing',
      l.roots[0].copies.find((c) => c.copyPath === a.copyPath)?.index,
      'missing'
    )
    check('Q8b: the stale line is not an error', l.index.errors.length, 0)
    check('Q8b: the stale line is reported stale', l.index.stale.join(','), b.copyPath)
    const comp = compactParkedIndex(indexPath)
    check('Q8b: compaction drops it', comp.dropped, 1)
    check(
      'Q8b: the next index omits it',
      fs.readFileSync(indexPath, 'utf8').includes(b.copyPath),
      false
    )
    appendParkedIndex(indexPath, {
      opId: 'op-x',
      path: '/abs/x',
      client: 'c',
      rootKey: null,
      kind: 'k',
      bytes: 1,
      createdAt: new Date().toISOString(),
    })
    check(
      'index: append after compaction keeps one line each',
      readParkedIndex(indexPath).entries.length,
      1
    )
  } finally {
    rmFixture(f.root)
  }
}

// Q10: git root -> suggestion once per root per run; .gitignore never edited
let hasGit = true
try {
  execFileSync('git', ['--version'], { stdio: 'pipe' })
} catch {
  hasGit = false
  console.log('[w5-index] Q10 NEVER-RAN: no git on this host (it is not a pass)')
}
if (hasGit) {
  const f = makeParent('w5-q10-')
  try {
    execFileSync('git', ['init', '-q', f.parent])
    fs.writeFileSync(path.join(f.parent, '.gitignore'), 'node_modules/\n')
    const before = fs.readFileSync(path.join(f.parent, '.gitignore'))
    park(f.parent, 'a', 'Q')
    const seen = new Set()
    const s1 = gitignoreSuggestion(f.parent, seen)
    park(f.parent, 'b', 'Q')
    const s2 = gitignoreSuggestion(f.parent, seen)
    check(
      'Q10: a suggestion on the first park',
      typeof s1 === 'string' && s1.includes('.skillsmith-trash'),
      true
    )
    check('Q10: none on the second park in the same run', s2, null)
    check(
      'Q10: a new run suggests again',
      typeof gitignoreSuggestion(f.parent, new Set()),
      'string'
    )
    check(
      'Q10: .gitignore bytes unchanged',
      fs.readFileSync(path.join(f.parent, '.gitignore')).equals(before),
      true
    )
    const st = execFileSync('git', [
      '-C',
      f.parent,
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]).toString()
    check(
      'Q10: git shows the trash as untracked',
      st.split('\n').includes('?? .skillsmith-trash/'),
      true
    )
  } finally {
    rmFixture(f.root)
  }
}

// Q9: the report names path, size, age, origin, class, and where the trash sits
{
  const f = makeParent('w5-q9-')
  try {
    const cs = ['Q', 'U', 'H'].map((s) => park(f.parent, `r${s}`, s))
    const text = formatTrashReport(listTrash({ roots: [f.parent] }))
    check(
      'Q9: every copy path appears',
      cs.every((c) => text.includes(c.copyPath)),
      true
    )
    check(
      'Q9: every origin appears',
      cs.every((c) =>
        text.includes(path.join(f.parent, path.basename(c.copyPath).replace(/-[0-9a-f]{8}$/, '')))
      ),
      true
    )
    check(
      'Q9: the classes appear',
      ['clean', 'unverified', 'held'].every((k) => text.includes(k)),
      true
    )
    check(
      'Q9: the "next to your own directory" sentence',
      text.includes('next to your own directory'),
      true
    )
    check('Q9: an age column', / \d+d /.test(text), true)
  } finally {
    rmFixture(f.root)
  }
}

done()

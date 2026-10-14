#!/usr/bin/env node
// SMI-7123 Wave 5, Sol confirmation round (c2) finding 1: the trace matcher sees
// only calls made through the fs DEFAULT object, so an aliased or async delete
// (`import { rmSync as erase } from 'node:fs'`, fs.rm, fs.promises.rm, callback
// fs.unlink) is invisible to it and a destructive mutant can PASS. The static fs
// boundary check (attacks/c4-fs-boundary.mjs) must therefore walk EVERY prune
// module and its imports, and reject rmSync outright there.
//
// DECLARED FAILURES ON THE PRE-FIX CODE (at assertions, not at import):
//  - coverage: the boundary check's entries are quarantine.mjs only, so the prune
//    modules are not in the files it checks;
//  - the alias-rmsync mutant is not rejected (it lives outside the checked graph);
//  - `fs.rmSync(p)` is not flagged (it is a traced *Sync function).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeCheck, rmFixture } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import { loadImpl, walkerOpts, readTrace, applyEdits } from './w5-variant.mjs'
import { matchPruneTrace } from './prune-trace-match.mjs'
import * as B from './attacks/c4-fs-boundary.mjs'
import { WALKER_MUTANTS } from './w5-mutants.mjs'

const { check, done } = makeCheck('[w5-boundary]')
const SPIKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The boundary checks that exist: an exported entry list, else (pre-fix) the one
// entry c4-fs-boundary.selftest.mjs walks.
const ENTRIES = B.FS_BOUNDARY_ENTRIES ?? [{ entry: 'quarantine.mjs', options: {} }]
const PRUNE_MODULES = [
  'prune.mjs',
  'prune.walk.mjs',
  'prune.walk.shared.mjs',
  'prune.walk.verify.mjs',
  'prune.walk.delete.mjs',
  'prune.leftovers.mjs',
  'prune.metadata.mjs',
  'prune.classify.mjs',
  'prune.sidecar.mjs',
  'trash-index.mjs',
  'trash-usage.mjs',
]
const runAll = (dir) => {
  const files = new Set()
  const violations = []
  for (const { entry, options } of ENTRIES) {
    const r = B.checkFsBoundary(path.join(dir, entry), options)
    for (const f of r.files) files.add(path.relative(dir, f))
    for (const v of r.violations) violations.push({ ...v, file: path.relative(dir, v.file ?? '') })
  }
  return { files, violations }
}

// --- the real code: every prune module is checked, and none violates ---------------
{
  const { files, violations } = runAll(SPIKE)
  for (const m of PRUNE_MODULES)
    check(`coverage: ${m} is in the files the boundary check walks`, files.has(m), true)
  check(
    `real code: no boundary violation${violations.length ? ` (${violations[0].file}: ${violations[0].violation})` : ''}`,
    violations.length,
    0
  )
}

// --- Sol's alias mutant -------------------------------------------------------------
{
  // Premise: the mutant is destructive, and the trace check alone cannot see it.
  const impl = await loadImpl('alias-rmsync')
  const f = makeParent('w5-bnd-')
  try {
    const c = park(f.parent, 't', 'Q')
    const sibling = path.join(c.opDir, 'other-00000000.json')
    fs.writeFileSync(sibling, 'sibling-bytes-never-approved')
    const traceFile = path.join(f.root, 'trace.json')
    const r = impl.prune({
      roots: [f.parent],
      apply: true,
      confirmBatch: () => true,
      walker: walkerOpts({ walkerPath: impl.walkerPath, traceFile }),
    })
    const t = readTrace(traceFile)
    const S =
      (t?.trace ?? []).find((x) => x.fn === 'mkdirSync' && /\.prune-[0-9a-f]{16}$/.test(x.a0 ?? ''))
        ?.a0 ?? null
    const m = matchPruneTrace(t, { root: f.root, S, copyPath: c.copyPath, opDir: c.opDir })
    check(
      'alias-rmsync premise: it destroyed the unapproved sibling',
      fs.existsSync(sibling),
      false
    )
    check('alias-rmsync premise: the copy was reported removed', r.items[0]?.status, 'removed')
    // RECORDED, not asserted: whether the trace check happens to see it depends on
    // the runtime. Node 22's rmSync recursion calls the interposed fs.unlinkSync on
    // inner entries, so on this runtime the trace may fail it INCIDENTALLY, by the
    // inner unlink's absolute path -- never by the aliased call itself, which is
    // never recorded. The guarantee is the static boundary check below.
    const aliasRecorded = (t?.trace ?? []).some((e) => e.fn === 'rmSync')
    console.log(
      `[w5-boundary] record: trace check ok=${m.ok}; aliased rmSync call itself recorded=${aliasRecorded}; first violation: ${m.violations[0] ?? 'none'}`
    )
    check(
      'alias-rmsync premise: the aliased call itself never reaches the trace',
      aliasRecorded,
      false
    )
  } finally {
    rmFixture(f.root)
  }
  // The boundary check over a mutated copy of the spike's modules must reject it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-bnd-copy-'))
  try {
    for (const n of fs.readdirSync(SPIKE))
      if (n.endsWith('.mjs')) fs.copyFileSync(path.join(SPIKE, n), path.join(tmp, n))
    const control = runAll(tmp)
    check('control: the unmutated copy has no boundary violation', control.violations.length, 0)
    const mu = WALKER_MUTANTS['alias-rmsync']
    const byFile = new Map()
    for (const e of mu.edits)
      (
        byFile.get(e.file ?? mu.file) ?? byFile.set(e.file ?? mu.file, []).get(e.file ?? mu.file)
      ).push(e)
    for (const [f2, edits] of byFile)
      fs.writeFileSync(
        path.join(tmp, f2),
        applyEdits(fs.readFileSync(path.join(tmp, f2), 'utf8'), edits, mu.name)
      )
    const r = runAll(tmp)
    const hit = r.violations.filter(
      (v) => v.file === 'prune.walk.mjs' && /non-default import/.test(v.violation)
    )
    check(
      'alias-rmsync: the boundary check rejects the named-import alias in prune.walk.mjs',
      hit.length > 0,
      true
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// --- synthetic sources: every alias / async / recursive delete shape -------------------
{
  const PRUNE_OPTS = (ENTRIES.find((e) => e.entry === 'prune.mjs') ?? {}).options ?? {}
  const flags = (src) => B.checkFsBoundarySource(src, PRUNE_OPTS).violations.length > 0
  const pre = "import fs from 'node:fs'\n"
  check(
    'synthetic: a named rmSync alias is rejected',
    flags("import { rmSync as erase } from 'node:fs'\nerase('/x')"),
    true
  )
  check(
    'synthetic: fs/promises is rejected',
    flags("import fsp from 'node:fs/promises'\nawait fsp.rm('/x')"),
    true
  )
  check('synthetic: fs.promises.rm is rejected', flags(`${pre}await fs.promises.rm('/x')`), true)
  check('synthetic: callback fs.rm is rejected', flags(`${pre}fs.rm('/x', () => {})`), true)
  check('synthetic: callback fs.unlink is rejected', flags(`${pre}fs.unlink('/x', () => {})`), true)
  check(
    'synthetic: fs.rmSync is rejected in prune modules',
    flags(`${pre}fs.rmSync('/x', { recursive: true })`),
    true
  )
  check('synthetic control: fs.unlinkSync is allowed', flags(`${pre}fs.unlinkSync('x')`), false)
  check('synthetic control: fs.rmdirSync is allowed', flags(`${pre}fs.rmdirSync('x')`), false)
}

done()

#!/usr/bin/env node
// SMI-7123 Wave 5, Sol code round 1 finding 3: the trace checker must reject a
// recursive or forced delete UNCONDITIONALLY, before any allowlist admits a path.
//
// DECLARED FAILURE ON THE PRE-FIX MATCHER: under the `opdir-rmsync` mutant
// (P4g's rmdirSync(job.opDir) -> rmSync(job.opDir, {recursive, force})) the
// sibling file in the op dir is destroyed, yet matchPruneTrace() returns ok:true,
// because the op dir is on its absolute-path allowlist and the allowlist
// `continue`s before the rmSync rejection.
import fs from 'node:fs'
import path from 'node:path'
import { makeCheck, rmFixture } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import { loadImpl, walkerOpts, readTrace } from './w5-variant.mjs'
import { matchPruneTrace } from './prune-trace-match.mjs'

const { check, done } = makeCheck('[w5-trace]')

/** One parked copy plus an orphan sidecar beside it in the same op dir (never inventoried). */
async function runCase(label, implName) {
  const impl = await loadImpl(implName)
  const f = makeParent('w5-trc-')
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
    const item = r.items[0] ?? {}
    const t = readTrace(traceFile)
    const m = matchPruneTrace(t, {
      root: f.root,
      S: item.stagingPath ?? findS(t),
      copyPath: c.copyPath,
      opDir: c.opDir,
    })
    return { item, m, siblingSurvives: exists(sibling) }
  } finally {
    rmFixture(f.root)
  }
}
const exists = (p) => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}
function findS(t) {
  const e = (t?.trace ?? []).find(
    (x) => x.fn === 'mkdirSync' && /\.prune-[0-9a-f]{16}$/.test(x.a0 ?? '')
  )
  return e ? e.a0 : null
}

// Real walker: the copy is removed, the sibling survives, the trace passes.
{
  const { item, m, siblingSurvives } = await runCase('real', null)
  check('real: the copy is removed', item.status, 'removed')
  check('real: the unapproved sibling in the op dir survives', siblingSurvives, true)
  check(
    `real: the trace invariant holds${m.violations.length ? ` (${m.violations[0]})` : ''}`,
    m.ok,
    true
  )
}

// Sol's mutation: the trace check must FAIL it.
{
  const { m, siblingSurvives } = await runCase('opdir-rmsync', 'opdir-rmsync')
  check(
    'opdir-rmsync premise: the mutation destroyed the unapproved sibling',
    siblingSurvives,
    false
  )
  check('opdir-rmsync: the trace check fails it', m.ok, false)
  check(
    'opdir-rmsync: the violation names the recursive delete',
    m.violations.some((v) => /rmSync/.test(v)),
    true
  )
}

// Synthetic traces: the allowlist may only ever admit single-entry unlink/rmdir.
{
  const S = '/x/trash/.prune-0123456789abcdef'
  const ctx = { S, copyPath: '/x/trash/op/c-00000000', opDir: '/x/trash/op' }
  const one = (e) => matchPruneTrace({ trace: [{ cwd: '/x', a1: null, ...e }] }, ctx)
  check(
    'synthetic: rmSync of S is rejected',
    one({ fn: 'rmSync', a0: S, recursive: true, force: true }).ok,
    false
  )
  check(
    'synthetic: rmSync of the op dir is rejected',
    one({ fn: 'rmSync', a0: '/x/trash/op' }).ok,
    false
  )
  check(
    'synthetic: a recursive rmdirSync of the op dir is rejected',
    one({ fn: 'rmdirSync', a0: '/x/trash/op', recursive: true }).ok,
    false
  )
  check('synthetic: unlinkSync of S itself is rejected', one({ fn: 'unlinkSync', a0: S }).ok, false)
  check(
    'synthetic: rmdirSync of S/deleting is rejected',
    one({ fn: 'rmdirSync', a0: `${S}/deleting` }).ok,
    false
  )
  check(
    'synthetic control: rmdirSync of the empty op dir is admitted',
    one({ fn: 'rmdirSync', a0: '/x/trash/op' }).ok,
    true
  )
  check(
    'synthetic control: unlinkSync of S/intent.json is admitted',
    one({ fn: 'unlinkSync', a0: `${S}/intent.json` }).ok,
    true
  )
}

done()

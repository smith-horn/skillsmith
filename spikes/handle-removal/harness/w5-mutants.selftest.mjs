#!/usr/bin/env node
// SMI-7123 Wave 5: every source mutant applies (each edit matches as declared)
// and its materialized copy parses; every function stub is exported. A mutant
// whose edit silently stopped matching would make its red run test the
// unmutated code, so this suite guards the guards.
import { pathToFileURL } from 'node:url'
import { makeCheck } from './w5-test-util.mjs'
import * as m from './w5-mutants.mjs'
import { materialize } from './w5-variant.mjs'

const { check, done } = makeCheck('[w5-mutants]')
for (const [label, table] of [
  ['walker mutant', m.WALKER_MUTANTS],
  ['mutation', m.MUTATIONS],
]) {
  for (const [name, mu] of Object.entries(table)) {
    let ok = true
    let err = ''
    try {
      const p = materialize(mu)
      await import(pathToFileURL(p).href)
    } catch (e) {
      ok = false
      err = String(e.message).slice(0, 160)
    }
    check(`${label} ${name} applies and loads${err ? ` (${err})` : ''}`, ok, true)
  }
}
for (const n of [
  'classifyLenient',
  'classifyDefaultClean',
  'readOnce',
  'pruneNaive',
  'pruneWarnOnly',
  'applyIgnored',
  'pruneResumeBlind',
]) {
  check(`stub ${n} is exported`, typeof m[n], 'function')
}
for (const n of ['prune-in-place', 'prune-follow', 'prune-c0'])
  check(`walker stub ${n}`, typeof m.WALKER_STUBS[n], 'function')
done()

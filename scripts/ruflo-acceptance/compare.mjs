#!/usr/bin/env node
// The § 2 arm-3 predicates, in one place, so an honest run and every mutant run
// are judged by the same code. Prints one line per predicate with BOTH values;
// nothing here is inferred from an exit code.
//
// Predicates, per blinded canary:
//   P1 returned == recomputed          (artifact-to-output equivalence)
//   P2 persisted == recomputed         (the store, read by the bypassing reader)
//   P3 returned == persisted           (round-3 finding 1: not "returns OR persists")
//   P4 exactly one named row           (table+namespace+key; 0 or >1 fails)
//   P5 canary WAL-residency observed   (recorded; a limitation, not a pass/fail)
//   P6 no shadow carrier               (no second row with this key or content)
//   P7 fresh-process retrieval agrees  (a NEW server session resolves the same
//                                       row content, and the bypassing reader
//                                       re-reads the same id and vector)
// Plus, across canaries:
//   P8 freshness                       (a mutated blinded input changes output)
//
// Byte equality is the predicate (ADR-170 § 2 determinism clause). When it does
// not hold, the max-abs-diff is printed and the 1e-6 tolerance is applied with
// the reason recorded by the caller -- the tolerance never silently substitutes
// for equality.
//
// Usage:
//   node compare.mjs --probe <p.json> --reader <r.json> --recompute <c.json>
//     [--fresh-probe <f.json>] [--fresh-reader <fr.json>] [--label <text>]
//     [--tolerance 1e-6] [--expect pass|fail]
// Exit: 0 all predicates held, 3 at least one failed, 2 malformed input.

import { readFileSync } from 'node:fs'

const opt = {
  probe: null,
  reader: null,
  recompute: null,
  freshProbe: null,
  freshReader: null,
  label: '',
  tolerance: 1e-6,
  expect: 'pass',
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--probe') opt.probe = argv[(i += 1)]
  else if (argv[i] === '--reader') opt.reader = argv[(i += 1)]
  else if (argv[i] === '--recompute') opt.recompute = argv[(i += 1)]
  else if (argv[i] === '--fresh-probe') opt.freshProbe = argv[(i += 1)]
  else if (argv[i] === '--fresh-reader') opt.freshReader = argv[(i += 1)]
  else if (argv[i] === '--label') opt.label = argv[(i += 1)]
  else if (argv[i] === '--tolerance') opt.tolerance = Number(argv[(i += 1)])
  else if (argv[i] === '--expect') opt.expect = argv[(i += 1)]
  else throw new Error(`unknown argument: ${argv[i]}`)
}

const J = (p) => JSON.parse(readFileSync(p, 'utf8'))
const probe = J(opt.probe)
const reader = J(opt.reader)
const recomp = J(opt.recompute)
const freshProbe = opt.freshProbe ? J(opt.freshProbe) : null
const freshReader = opt.freshReader ? J(opt.freshReader) : null

let failures = 0
const short = (v) =>
  Array.isArray(v)
    ? `[len=${v.length} ${v
        .slice(0, 3)
        .map((x) => x.toPrecision(9))
        .join(', ')} ...]`
    : JSON.stringify(v)

function predicate(name, ok, expected, actual, note) {
  const verdict = ok ? 'HELD' : 'FAILED'
  if (!ok) failures += 1
  process.stdout.write(
    `  predicate ${name}: ${verdict}\n    expected: ${expected}\n    actual:   ${actual}\n${note ? `    note:     ${note}\n` : ''}`
  )
}

function vecCompare(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b))
    return { equal: false, reason: 'one side is not an array', maxAbsDiff: null }
  if (a.length !== b.length)
    return { equal: false, reason: `length ${a.length} vs ${b.length}`, maxAbsDiff: null }
  let maxAbsDiff = 0
  let byteEqual = true
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) byteEqual = false
    const d = Math.abs(a[i] - b[i])
    if (d > maxAbsDiff) maxAbsDiff = d
  }
  return { equal: byteEqual, maxAbsDiff, reason: byteEqual ? 'byte-equal' : 'differs' }
}

function judge(name, a, b, aLabel, bLabel) {
  const r = vecCompare(a, b)
  if (r.equal) {
    predicate(name, true, `${aLabel} == ${bLabel} (byte equality)`, `byte-equal, len=${a.length}`)
    return true
  }
  const withinTol = r.maxAbsDiff != null && r.maxAbsDiff <= opt.tolerance
  predicate(
    name,
    withinTol,
    `${aLabel} == ${bLabel} (byte equality; tolerance ${opt.tolerance} under the determinism clause)`,
    `${r.reason}; maxAbsDiff=${r.maxAbsDiff}; ${aLabel}=${short(a)} ${bLabel}=${short(b)}`,
    withinTol ? 'byte equality did NOT hold; passed only under the stated tolerance' : undefined
  )
  return withinTol
}

// Pull the returned vectors out of the probe evidence by the label the plan set.
function returnedVectors(ev) {
  const out = {}
  for (const r of ev.responses) {
    if (
      r.label &&
      r.label.startsWith('generate:') &&
      r.parsed &&
      Array.isArray(r.parsed.embedding)
    ) {
      out[r.label.slice('generate:'.length)] = {
        embedding: r.parsed.embedding,
        metadata: r.parsed.metadata,
      }
    }
  }
  return out
}

const returned = returnedVectors(probe)
process.stdout.write(`\n== § 2 arm 3 predicates ${opt.label ? `(${opt.label})` : ''}\n`)
process.stdout.write(
  `  probe outcome=${probe.outcome} canaries=${probe.canaries.length} recompute.where=${recomp.where} recompute.transformers=${recomp.transformersVersion}\n`
)

for (const { c, f } of probe.canaries) {
  process.stdout.write(`\n  canary ${c} (freshness mutant ${f})\n`)
  const ret = returned[c]?.embedding ?? null
  const rec = recomp.vectors[c] ?? null
  const row = reader.rows[c] ?? null
  const per = row?.embedding ?? null

  if (!ret)
    predicate(
      'P1 returned==recomputed',
      false,
      'a returned vector for this canary',
      'none in the probe evidence'
    )
  else if (!rec)
    predicate(
      'P1 returned==recomputed',
      false,
      'a recomputed vector for this canary',
      'none in the recompute evidence'
    )
  else judge('P1 returned==recomputed', ret, rec, 'returned', 'recomputed')

  if (!per)
    predicate(
      'P2 persisted==recomputed',
      false,
      'a persisted vector for this canary',
      `reader row: ${JSON.stringify(row)}`
    )
  else if (!rec) predicate('P2 persisted==recomputed', false, 'a recomputed vector', 'none')
  else judge('P2 persisted==recomputed', per, rec, 'persisted', 'recomputed')

  if (!per || !ret)
    predicate(
      'P3 returned==persisted',
      false,
      'both vectors present',
      `returned=${!!ret} persisted=${!!per}`
    )
  else judge('P3 returned==persisted', ret, per, 'returned', 'persisted')

  predicate(
    'P4 exactly one named row',
    row?.rowCount === 1,
    `exactly 1 row in ${reader.table} with namespace=${reader.namespace} key=${c}`,
    `rowCount=${row?.rowCount ?? 'n/a'} id=${row?.id ?? 'n/a'} model=${row?.embeddingModel ?? 'n/a'} dims=${row?.embeddingDimensions ?? 'n/a'}`
  )

  const mainOnly = reader.mainFileOnly?.[c]
  const walResident = mainOnly ? mainOnly.rowCount === 0 : null
  process.stdout.write(
    `  observation P5 WAL-residency: canary ${walResident === true ? 'WAS' : 'was NOT'} WAL-resident at read time` +
      ` (source -wal = ${reader.walSizeBytes} B; main-file-only copy held ${mainOnly?.rowCount ?? 'n/a'} matching rows)\n`
  )

  predicate(
    'P6 no shadow carrier',
    row?.rowsWithThisKeyAnyNamespace === 1 && row?.rowsWithThisContentAnyNamespace === 1,
    'exactly 1 row carries this key, and exactly 1 carries this content, across all namespaces',
    `byKey=${row?.rowsWithThisKeyAnyNamespace ?? 'n/a'} byContent=${row?.rowsWithThisContentAnyNamespace ?? 'n/a'} ${JSON.stringify(row?.rowsWithThisContent ?? [])}`
  )

  if (freshProbe && freshReader) {
    const fr = freshReader.rows?.[c] ?? null
    const retrieved = freshProbe.responses.find((r) => r.label === `retrieve:${c}`)?.parsed ?? null
    const searched = freshProbe.responses.find((r) => r.label === `search:${c}`)?.parsed ?? null
    const idSame = fr && row && fr.id === row.id
    const vecSame = fr && row ? vecCompare(fr.embedding, row.embedding).equal : false
    const foundOk = retrieved?.found === true && retrieved?.value === c
    // Not "exactly one result": the namespace legitimately holds other canaries
    // from earlier runs. The shadow-carrier mutation is a SECOND result carrying
    // the SAME content, so the predicate counts results whose value is this
    // canary and requires exactly one, under this canary's own key.
    const byValue = Array.isArray(searched?.results)
      ? searched.results.filter((r) => r.value === c)
      : []
    const searchOk = byValue.length === 1 && byValue[0].key === c
    predicate(
      'P7 fresh-process retrieval agrees',
      Boolean(idSame && vecSame && foundOk && searchOk),
      'a NEW server process resolves (namespace,key) to this canary and returns exactly one search result carrying its content, under its own key; the bypassing reader re-reads the same primary key and the same vector',
      `freshRetrieve.found=${retrieved?.found} value==canary:${retrieved?.value === c} freshSearch.results=${searched?.results?.length ?? 'n/a'}` +
        ` resultsCarryingThisCanaryValue=${byValue.length} keys=${JSON.stringify(byValue.map((r) => r.key))}` +
        ` readerIdSame=${idSame} readerVectorSame=${vecSame} id=${row?.id ?? 'n/a'} -> ${fr?.id ?? 'n/a'}`,
      'no served tool in 3.42.4 exposes the row primary key, so the PK half of this predicate is established by the bypassing reader re-read, not by the served reply -- see the harness report'
    )
  }
}

// ---- P8 freshness -----------------------------------------------------------
for (const { c, f } of probe.canaries) {
  const a = returned[c]?.embedding ?? null
  const b = returned[f]?.embedding ?? null
  if (!a || !b) {
    predicate(
      'P8 freshness',
      false,
      'a returned vector for both the canary and its mutant',
      `canary=${!!a} mutant=${!!b}`
    )
    continue
  }
  const r = vecCompare(a, b)
  predicate(
    'P8 freshness',
    !r.equal && r.maxAbsDiff > opt.tolerance,
    `the output for the mutated blinded input differs from the output for ${c}`,
    `maxAbsDiff=${r.maxAbsDiff} equal=${r.equal} mutantInput=${f}`
  )
}

const verdict = failures === 0 ? 'pass' : 'fail'
process.stdout.write(
  `\n  RESULT ${opt.label}: ${verdict} (${failures} failed predicate${failures === 1 ? '' : 's'}); expected=${opt.expect}\n`
)
process.exit(failures === 0 ? 0 : 3)

#!/usr/bin/env node
// SMI-7123 Wave 5 (design §6): runs the Q6-Q10, R1, P1-P9 and W1 rows.
//
//   node run-w5-rows.mjs --out <path> --fs-label <apfs|overlayfs|tmpfs|ext4|virtiofs>
//                        [--only Q6,P1,...] [--target <n per variant per arm>]
//
// --out has no default. A --target below a row's design target is refused when
// --out resolves under results/raw/ (the summary generator has no notion of a
// target, so a short run there would read as PASS); smoke runs go elsewhere.
// Fixtures are created under SMI6676_HARNESS_ROOT (else os.tmpdir()), so the
// filesystem under test is chosen by the caller, as for the C4 runners.
//
// `--only P1-M5` additionally runs mutation M5 (mountinfo skipped in P4e) as the
// candidate of P1's bind/pre-verify variant; its expected verdict is FAIL.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRecord, appendJsonl } from './result-schema.mjs'
import { shortTargetRefusal, parseFlags, harnessErrorRaw } from './c4-target-guard.mjs'
import { W5_ROWS, controlsFor, w5Verdict } from './control-spec.w5.mjs'
import { W5_CONTRADICTS } from './w5-rows-common.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RAW_DIR = path.resolve(HERE, '..', 'results', 'raw')
const parsed = parseFlags(process.argv.slice(2), {
  '--out': { key: 'out', kind: 'string' },
  '--fs-label': { key: 'fs', kind: 'string' },
  '--only': { key: 'only', kind: 'list' },
  '--target': { key: 'target', kind: 'int' },
})
if (parsed.error) {
  console.error(`[run-w5-rows] ${parsed.error}`)
  process.exit(2)
}
const { out, fs: fsLabel, only, target } = parsed.opts
if (!out || !fsLabel) {
  console.error('[run-w5-rows] --out and --fs-label are required (no defaults)')
  process.exit(2)
}
const wantM5 = (only ?? []).includes('P1-M5')
const rows = (only ?? Object.keys(W5_ROWS)).filter((r) => r !== 'P1-M5')
for (const r of rows) {
  if (!W5_ROWS[r]) {
    console.error(`[run-w5-rows] unknown row ${r}`)
    process.exit(2)
  }
}
const refusal = shortTargetRefusal({
  out,
  requested: target ?? null,
  modules: rows.map((r) => ({ name: r, target: W5_ROWS[r].target })),
  rawDir: RAW_DIR,
})
if (refusal) {
  console.error(`[run-w5-rows] ${refusal}`)
  process.exit(2)
}

const modules = {}
const rowDef = async (r) => {
  const file = r.startsWith('Q')
    ? 'w5-rows-q.mjs'
    : ['R1', 'P5', 'P6', 'W1'].includes(r)
      ? 'w5-rows-r.mjs'
      : 'w5-rows-p.mjs'
  modules[file] ??= await import(`./${file}`)
  const m = modules[file]
  return (m.Q_ROWS ?? {})[r] ?? (m.R_ROWS ?? {})[r] ?? (m.P_ROWS ?? {})[r]
}

function record(row, arm, variant, i, rawRec, n) {
  return makeRecord({
    cell: {
      attack: `W5-${row}`,
      candidate: arm,
      variant: variant ?? null,
      fs: fsLabel,
      runner: 'run-w5-rows',
      target: n,
    },
    run: i,
    precondition: rawRec.precondition,
    outcome: rawRec.outcome,
    userFiles: rawRec.userFiles,
    fsCheck: { ...rawRec.fsCheck, extra: rawRec.extra ?? null },
  })
}

function runArm(row, def, arm, fn, n) {
  const recs = []
  for (const variant of def.variants) {
    for (let i = 0; i < n; i += 1) {
      let rawRec
      try {
        rawRec = fn(variant)
      } catch (err) {
        rawRec = {
          ...harnessErrorRaw(err),
          fsCheck: { ok: true, failures: [] },
          extra: { error: String(err?.stack ?? err).slice(0, 400) },
        }
      }
      const rec = record(row, arm, variant, i, rawRec, n * def.variants.length)
      appendJsonl(out, rec)
      recs.push(rec)
    }
  }
  return recs
}

const summarize = (recs) => {
  const by = {}
  for (const r of recs) {
    const k = `${r.cell.variant ?? '-'}`
    const s = (by[k] ??= { ran: 0, failed: 0, neverRan: 0, first: null })
    s.ran += 1
    if (
      r.outcome.status === 'harness-error' ||
      Object.values(r.precondition).some((v) => v === false)
    ) {
      s.neverRan += 1
      s.first ??= `never-ran: ${r.fsCheck?.extra?.neverRan ?? r.outcome.reason ?? ''}`
    } else if (W5_CONTRADICTS(r) || r.userFiles.lost + r.userFiles.changed > 0) {
      s.failed += 1
      s.first ??= `${r.outcome.status}/${r.outcome.reason}: ${(r.fsCheck?.failures ?? []).join('; ')}`
    }
  }
  return by
}

const n = target ?? null
let exit = 0
for (const row of rows) {
  const def = await rowDef(row)
  const per = n ?? W5_ROWS[row].target
  const cand = runArm(row, def, 'candidate', def.arms.candidate, per)
  const ctl = {}
  for (const c of controlsFor(row)) ctl[c] = runArm(row, def, c, def.arms[c], per)
  const v = w5Verdict(row, cand, ctl, W5_CONTRADICTS, per * def.variants.length)
  const expected = W5_ROWS[row].expected[process.platform] ?? '(no expectation for this platform)'
  console.log(`${v.line}\tcontrol=${v.ctl.state} (${v.ctl.detail})`)
  console.log(`  expected: ${expected}`)
  for (const [variant, s] of Object.entries(summarize(cand)))
    console.log(
      `  candidate ${variant}: ran=${s.ran} failed=${s.failed} never-ran=${s.neverRan}${s.first ? ` first: ${s.first.slice(0, 300)}` : ''}`
    )
  for (const [c, recs] of Object.entries(ctl))
    for (const [variant, s] of Object.entries(summarize(recs)))
      console.log(
        `  control ${c} ${variant}: ran=${s.ran} failed=${s.failed} never-ran=${s.neverRan}${s.first ? ` first: ${s.first.slice(0, 200)}` : ''}`
      )
  // A record-only row's losses are recorded, not scored (design §6 P2r).
  if (v.agg.failed > 0 && !W5_ROWS[row].recordOnly) exit = 1
}
if (wantM5) {
  const { M5_P1 } = await import('./w5-rows-p.mjs')
  const def = { variants: ['bind/pre-verify'] }
  const recs = runArm('P1', def, 'M5', M5_P1, n ?? 1)
  for (const [variant, s] of Object.entries(summarize(recs)))
    console.log(
      `M5 (mountinfo skipped in P4e) P1 ${variant}: ran=${s.ran} failed=${s.failed} never-ran=${s.neverRan} -- expected failed>0${s.first ? ` first: ${s.first.slice(0, 300)}` : ''}`
    )
}
process.exit(exit)

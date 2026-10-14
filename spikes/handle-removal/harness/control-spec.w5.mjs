// SMI-7123 Wave 5 (design §6): one control row per runnable row, resolved from
// THIS RUN's paired arm -- never from a cited earlier run, never assumed.
//
// A row's verdict is aggregateCell(candidate records, {target, controlFailed})
// where controlFailed is true only when EVERY control arm of the row recorded at
// least one genuine failure in this same invocation and filesystem. A control
// that did not fail makes the row NEVER-RAN (control): the fixture did not
// demonstrate the loss it exists to demonstrate.
//
// `expected` is the verdict the design predicts for the candidate arm on each
// platform; the runner prints actual beside expected. `targets` are the design's
// run counts (the owner approves the at-scale run; smoke runs pass a lower
// --target and must write outside results/raw).

import { aggregateCell, formatVerdict } from './result-schema.mjs'
import { recordOnlyVerdict } from './control-spec.c4.mjs'

const both = (v) => ({ darwin: v, linux: v })

/** design §6, one entry per row. controls: [] means "no loss to demonstrate". */
export const W5_ROWS = {
  Q6: { target: 10, controls: ['C4-stateroot'], expected: both('PASS') },
  Q7: { target: 10, controls: ['C4-consolation'], expected: both('PASS') },
  Q8: {
    target: 5,
    controls: ['list-index-only', 'list-throwing', 'list-scan-path'],
    expected: both('PASS'),
  },
  Q9: { target: 5, controls: ['report-drop-origin'], expected: both('PASS') },
  Q10: {
    target: 5,
    controls: ['gitignore-editor'],
    expected: { darwin: 'PASS', linux: 'PASS (needs git in the container; else NEVER-RAN)' },
  },
  R1: { target: 10, controls: ['prune-naive'], expected: both('PASS') },
  // prune-c0 is the control for the Linux same-dev bind only (design §6); darwin
  // has no same-dev bind, so its st_dev guard would skip an hdiutil volume.
  P1: {
    target: 30,
    controls: { darwin: ['prune-naive'], linux: ['prune-naive', 'prune-c0'] },
    expected: both('PASS'),
  },
  P2: { target: 30, controls: ['prune-naive'], expected: both('PASS') },
  P2r: {
    target: 30,
    controls: [],
    recordOnly: true,
    expected: both('RECORD-ONLY (n lost) -- residual R-open (b)(i)'),
  },
  // Sol c1 finding 1 (owner 2026-10-14): out of model under ADR-166 D-0, documented
  // as residual R-swap; recorded, never scored.
  Pswap: {
    target: 30,
    controls: [],
    recordOnly: true,
    expected: both('RECORD-ONLY (n lost) -- out-of-model residual R-swap'),
  },
  P3: { target: 30, controls: ['prune-in-place'], expected: both('PASS') },
  P4: { target: 30, controls: ['prune-naive'], expected: both('PASS') },
  P5: { target: 10, controls: ['prune-resume-blind'], expected: both('PASS') },
  P6: { target: 10, controls: ['prune-warn-only'], expected: both('PASS') },
  P7: { target: 30, controls: ['prune-follow'], expected: both('PASS') },
  P8: { target: 30, controls: ['sidecar-same-inode-rewrite'], expected: both('PASS') },
  P9: {
    target: 30,
    controls: ['misplace-silent', 'misplace-revert'],
    expected: {
      darwin: 'PASS',
      linux: 'PASS ((i) only; (ii) is darwin-only and records NEVER-RAN)',
    },
  },
  W1: { target: 5, controls: ['warn-max-not-min'], expected: both('PASS') },
}

/**
 * Resolves one row's control state from its control arms' records.
 * @param {string} rowId
 * @param {Record<string, object[]>} controlRecords - control name -> records (this run)
 * @param {(r:object)=>boolean} contradicts
 * @returns {{state:'satisfied'|'did-not-fail'|'absent'|'none', detail:string, perControl:object}}
 */
/** The control arms a row runs on this platform. */
export function controlsFor(rowId, platform = process.platform) {
  const c = W5_ROWS[rowId]?.controls ?? []
  return Array.isArray(c) ? c : (c[platform] ?? [])
}

export function resolveW5Control(rowId, controlRecords, contradicts) {
  const row = W5_ROWS[rowId]
  if (!row) return { state: 'unspecified', detail: `no W5 row ${rowId}`, perControl: {} }
  const controls = controlsFor(rowId)
  if (controls.length === 0)
    return { state: 'none', detail: 'no loss to demonstrate (record-only)', perControl: {} }
  const perControl = {}
  for (const c of controls) {
    const recs = controlRecords[c] ?? []
    const agg = recs.length ? aggregateCell(recs, contradicts) : null
    perControl[c] = agg
      ? { ran: agg.ran, failed: agg.controlFailures ?? agg.failed }
      : { ran: 0, failed: 0 }
  }
  const missing = controls.filter((c) => perControl[c].ran === 0)
  if (missing.length)
    return { state: 'absent', detail: `control arm(s) not run: ${missing.join(', ')}`, perControl }
  const didNot = controls.filter((c) => perControl[c].failed < 1)
  if (didNot.length)
    return {
      state: 'did-not-fail',
      detail: `control(s) recorded 0 failures: ${didNot.join(', ')}`,
      perControl,
    }
  return {
    state: 'satisfied',
    detail: controls
      .map((c) => `${c} failed ${perControl[c].failed}/${perControl[c].ran}`)
      .join('; '),
    perControl,
  }
}

/** The candidate arm's verdict line for a row. */
export function w5Verdict(rowId, candidateRecords, controlRecords, contradicts, target) {
  const row = W5_ROWS[rowId]
  const ctl = resolveW5Control(rowId, controlRecords, contradicts)
  const controlFailed = ctl.state === 'satisfied' ? true : ctl.state === 'none' ? undefined : false
  const agg = aggregateCell(candidateRecords, contradicts, { target, controlFailed })
  if (row.recordOnly)
    agg.verdict = recordOnlyVerdict({ failed: agg.failed, neverRan: agg.neverRan })
  return { agg, ctl, line: formatVerdict(`W5-${rowId}`, agg) }
}

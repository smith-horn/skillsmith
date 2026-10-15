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

/**
 * design §6, one entry per row. controls: [] means "no loss to demonstrate".
 * `variants` is how many variants the row's attack module defines (a number, or per
 * platform where the module's list depends on it: Q7, P9, and P1 on a root Linux
 * run). The runner scores a row with target * variants; w5-summary.mjs needs the same
 * product because real records do not carry a target. control-spec.w5.selftest.mjs
 * loads every module the way run-w5-rows.mjs does and fails if a value drifts.
 */
export const W5_ROWS = {
  Q6: { target: 10, variants: 1, controls: ['C4-stateroot'], expected: both('PASS') },
  Q7: {
    target: 10,
    variants: { darwin: 3, linux: 5 },
    controls: ['C4-consolation'],
    expected: both('PASS'),
  },
  Q8: {
    target: 5,
    variants: 3,
    controls: ['list-index-only', 'list-throwing', 'list-scan-path'],
    expected: both('PASS'),
  },
  Q9: { target: 5, variants: 1, controls: ['report-drop-origin'], expected: both('PASS') },
  Q10: {
    target: 5,
    variants: 1,
    controls: ['gitignore-editor'],
    expected: { darwin: 'PASS', linux: 'PASS (needs git in the container; else NEVER-RAN)' },
  },
  R1: { target: 10, variants: 2, controls: ['prune-naive'], expected: both('PASS') },
  // prune-c0 is the control for the Linux same-dev bind only (design §6); darwin
  // has no same-dev bind, so its st_dev guard would skip an hdiutil volume.
  P1: {
    target: 30,
    variants: { darwin: 3, linux: 6 },
    controls: { darwin: ['prune-naive'], linux: ['prune-naive', 'prune-c0'] },
    expected: both('PASS'),
  },
  P2: { target: 30, variants: 1, controls: ['prune-naive'], expected: both('PASS') },
  P2r: {
    target: 30,
    variants: 1,
    controls: [],
    recordOnly: true,
    expected: both('RECORD-ONLY (n lost) -- residual R-open (b)(i)'),
  },
  // Sol c1 finding 1 (owner 2026-10-14): out of model under ADR-166 D-0, documented
  // as residual R-swap; recorded, never scored.
  Pswap: {
    target: 30,
    variants: 1,
    controls: [],
    recordOnly: true,
    expected: both('RECORD-ONLY (n lost) -- out-of-model residual R-swap'),
  },
  // Sol c2 finding 2: metadata now removed by rename-to-random, re-check, unlink;
  // a swap at the random name is the same out-of-model R-swap class. Recorded only.
  Pmswap: {
    target: 30,
    variants: 1,
    controls: [],
    recordOnly: true,
    expected: both('RECORD-ONLY (n lost) -- R-swap class at the random metadata name'),
  },
  P3: { target: 30, variants: 1, controls: ['prune-in-place'], expected: both('PASS') },
  P4: { target: 30, variants: 1, controls: ['prune-naive'], expected: both('PASS') },
  P5: { target: 10, variants: 6, controls: ['prune-resume-blind'], expected: both('PASS') },
  P6: { target: 10, variants: 1, controls: ['prune-warn-only'], expected: both('PASS') },
  P7: { target: 30, variants: 2, controls: ['prune-follow'], expected: both('PASS') },
  P8: { target: 30, variants: 2, controls: ['sidecar-same-inode-rewrite'], expected: both('PASS') },
  P9: {
    target: 30,
    variants: { darwin: 2, linux: 1 },
    controls: ['misplace-silent', 'misplace-revert'],
    expected: {
      darwin: 'PASS',
      linux: 'PASS ((i) only; (ii) is darwin-only and records NEVER-RAN)',
    },
  },
  W1: { target: 5, variants: 5, controls: ['warn-max-not-min'], expected: both('PASS') },
}

/** The number of variants a row defines on `platform`. */
export function w5VariantCount(rowId, platform = process.platform) {
  const v = W5_ROWS[rowId]?.variants
  return typeof v === 'number' ? v : (v?.[platform] ?? null)
}

/** The design run count for one candidate arm on `platform` (target x variants), or null if unknown. */
export function w5DesignRuns(rowId, platform = process.platform) {
  const n = w5VariantCount(rowId, platform)
  return n === null ? null : W5_ROWS[rowId].target * n
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

/**
 * A W5 run fails when its row recorded a failure (fsCheck.ok false). Defined here,
 * beside the verdict, so the runner and results/generate-summary.mjs score with
 * one definition (w5-rows-common.mjs re-exports it).
 */
export const W5_CONTRADICTS = (rec) => rec.fsCheck?.ok === false

// `platform`: the platform the RECORDS were made on (cell.platform), so the
// summary scores a Linux file with Linux's control set even when generated on
// darwin. Defaults to this process's platform, which is the runner's case.
export function resolveW5Control(rowId, controlRecords, contradicts, platform = process.platform) {
  const row = W5_ROWS[rowId]
  if (!row) return { state: 'unspecified', detail: `no W5 row ${rowId}`, perControl: {} }
  const controls = controlsFor(rowId, platform)
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

/**
 * What a (row, fs) group must agree on before ONE verdict may stand for it: the
 * candidate records share one `cell.target`, and every record (candidate and
 * control) shares one platform and one run identity (runner, arch, node, os).
 * The verdict is scored with a single target and platform, so a group that mixes
 * them would be scored against the first record's values and read as one run
 * (cf. C4's `targetState` 'inconsistent', cell-tally.mjs).
 * @returns {string[]} the names that disagree, empty when the group is consistent
 */
export function w5GroupMixed(candidateRecords, controlRecords = {}) {
  const all = [...candidateRecords, ...Object.values(controlRecords).flat()]
  const distinct = (rs, pick) => new Set(rs.map((r) => JSON.stringify(pick(r.cell ?? {}) ?? null)))
  const mixed = []
  if (distinct(candidateRecords, (c) => c.target).size > 1) mixed.push('target')
  if (distinct(all, (c) => c.platform).size > 1) mixed.push('platform')
  if (distinct(all, (c) => [c.runner, c.arch, c.node, c.os]).size > 1) mixed.push('run')
  return mixed
}

/** The candidate arm's verdict line for a row. */
export function w5Verdict(
  rowId,
  candidateRecords,
  controlRecords,
  contradicts,
  target,
  platform = process.platform
) {
  const row = W5_ROWS[rowId]
  const ctl = resolveW5Control(rowId, controlRecords, contradicts, platform)
  const controlFailed = ctl.state === 'satisfied' ? true : ctl.state === 'none' ? undefined : false
  const agg = aggregateCell(candidateRecords, contradicts, { target, controlFailed })
  // A mixed group is INCOMPLETE, never a clean verdict -- but failures still beat it,
  // as in cellVerdict(): a measured loss is evidence whatever the group looks like.
  const mixed = w5GroupMixed(candidateRecords, controlRecords)
  if (mixed.length > 0 && agg.failed === 0)
    agg.verdict = `INCOMPLETE (inconsistent ${mixed.join(', ')} in one group)`
  // RECORD-ONLY names the loss and never-ran counts, but it must not replace a verdict
  // that says the run is short or did not run: INCOMPLETE / NEVER-RAN stay visible.
  if (row.recordOnly && !/^(INCOMPLETE|NEVER-RAN)/.test(agg.verdict))
    agg.verdict = recordOnlyVerdict({ failed: agg.failed, neverRan: agg.neverRan })
  return { agg, ctl, line: formatVerdict(`W5-${rowId}`, agg) }
}

// SMI-7123 Wave 5: the W5 section of results/SUMMARY.md, scored by THE SAME
// verdict function run-w5-rows.mjs uses (control-spec.w5.mjs w5Verdict), at the
// runner's granularity: one line per (row, fs). The verdict is w5Verdict's; the single
// adjustment made here is the no-design-count override below, which downgrades a
// PASS-family verdict to INCOMPLETE and leaves every other verdict as scored.
//
// Each (row, fs) group is scored with the platform its records were made on
// (cell.platform) and the target the runner recorded (cell.target), so a Linux
// file is scored with Linux's control set even when the summary is built on darwin.
import { W5_ROWS, W5_CONTRADICTS, w5Verdict, w5DesignRuns } from './control-spec.w5.mjs'
import { verdictTallyKey } from './control-spec.mjs'

const isW5 = (r) => typeof r?.cell?.attack === 'string' && r.cell.attack.startsWith('W5-')
export { isW5 }

/**
 * @param {object[]} records - W5 records (cell.attack starts with 'W5-')
 * @returns {{lines:string[], tally:object, rows:number, ignored:number}}
 */
export function w5SummarySection(records) {
  const groups = new Map()
  for (const r of records) {
    const key = `${r.cell.attack}\0${r.cell.fs}`
    if (!groups.has(key)) groups.set(key, { attack: r.cell.attack, fs: r.cell.fs, records: [] })
    groups.get(key).records.push(r)
  }
  const order = Object.keys(W5_ROWS)
  const fsOrder = ['apfs', 'overlayfs', 'tmpfs', 'ext4', 'virtiofs']
  const rank = (a, list) => (list.indexOf(a) === -1 ? list.length : list.indexOf(a))
  const sorted = [...groups.values()].sort(
    (a, b) =>
      rank(a.attack.slice(3), order) - rank(b.attack.slice(3), order) ||
      rank(a.fs, fsOrder) - rank(b.fs, fsOrder) ||
      a.fs.localeCompare(b.fs)
  )
  const lines = []
  const tally = {}
  let ignored = 0
  for (const g of sorted) {
    const rowId = g.attack.slice(3)
    const cand = g.records.filter((r) => r.cell.candidate === 'candidate')
    const ctl = {}
    for (const r of g.records) {
      if (r.cell.candidate === 'candidate') continue
      ;(ctl[r.cell.candidate] ??= []).push(r)
    }
    if (!W5_ROWS[rowId] || cand.length === 0) {
      ignored += g.records.length
      lines.push(
        `| ${g.attack} | ${g.fs} | UNSPECIFIED | ${cand.length} | - | - | - | no W5 row or no candidate records |`
      )
      continue
    }
    // w5Verdict scores with ONE target and platform (the first candidate's), and itself
    // reports the group INCOMPLETE when its records do not all share them (w5GroupMixed).
    const platform = cand[0].cell.platform
    // Real W5 records carry no cell.target (makeRecord drops it for non-C4 cells), so the
    // expected run count is the design count the runner scored with: target x variants.
    // A platform with no known design count has no expected run count to score against:
    // that group is INCOMPLETE, never a PASS against its own record count (SMI-7132 F5).
    // A measured failure still outranks it, as in w5Verdict.
    const target = cand[0].cell.target ?? w5DesignRuns(rowId, platform) ?? undefined
    const v = w5Verdict(rowId, cand, ctl, W5_CONTRADICTS, target, platform)
    const a = v.agg
    if (target === undefined && a.failed === 0 && /^PASS/.test(a.verdict)) {
      a.verdict = `INCOMPLETE (no design count for platform ${platform})`
    }
    lines.push(
      `| ${g.attack} | ${g.fs} | ${a.verdict} | ${a.ran} | ${a.passed} | ${a.failed} | ${a.neverRan} | ${v.ctl.state} (${v.ctl.detail}) |`
    )
    const key = verdictTallyKey(a.verdict)
    tally[key] = (tally[key] ?? 0) + 1
  }
  return { lines, tally, rows: sorted.length, ignored }
}

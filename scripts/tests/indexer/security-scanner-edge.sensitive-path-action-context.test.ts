/**
 * SMI-5207 (Wave 1 Step 3, item d): the exact-threshold co-signal pair.
 * @module scripts/tests/indexer/security-scanner-edge.sensitive-path-action-context
 *
 * A sibling to security-scanner-edge.co-signal-escalation.test.ts and
 * security-scanner-edge.paste-host.test.ts, scoped narrowly to the one
 * behavioral transition the plan calls out as both its primary indexer-path
 * clearing mechanism AND its primary false-negative risk (see the plan's
 * "Cross-cutting: the co-signal demotion" section):
 *
 *   - a MEDIUM `code_execution` finding (a free-text fetch-and-execute
 *     imperative, sub-threshold alone: 15 * 2.0 * 1.0 = 30, cap 100,
 *     * 0.4 = 12.0) PLUS an action-gated (MF-3 HIGH) `sensitive_path`
 *     finding within the 40-line co-signal window escalates `code_execution`
 *     to CRITICAL via
 *     `escalateCodeExecution`'s path (a) — total riskScore lands at 41
 *     (40.0 from the escalated code_execution + 1.44 from the sensitive_path
 *     HIGH finding itself), clearing the 40-point quarantine threshold.
 *   - the SAME `code_execution` finding PLUS a bare `sensitive_path` MENTION
 *     (no action verb/shell operator within +/-1 line, so MF-3 leaves it at
 *     MEDIUM) does NOT escalate — `sensitive_path` is a high-MINIMUM-only
 *     co-signal type (`CO_SIGNAL_MIN_SEVERITY.sensitive_path === 'high'`),
 *     so a medium-severity sensitive_path finding is ineligible for either
 *     escalation path. Total riskScore lands at 13
 *     (12.0 + 15 * 1.2 * 0.7 = 12.6, cap 100, * 0.04 = 0.504 → 12.504,
 *     rounded), comfortably clear.
 *
 * Both fixtures are asserted through the Node twin
 * (`scripts/indexer/_shared/security-scanner-edge.ts`'s `scanSkillContent`/
 * `shouldQuarantine`) ONLY — see the "Deno substrate" note below for why the
 * Deno side is not separately re-run here rather than silently skipped.
 *
 * Deno substrate note: no sibling test file in this suite (co-signal-
 * escalation, paste-host, archive-gatekeeper, decoy-misdirection, etc.)
 * ever executes `supabase/functions/_shared/*.ts` directly — Vitest/Node has
 * no Deno runtime, and `.ts`-suffixed relative imports plus Deno-only
 * globals (`Deno.serve`, `crypto.subtle` availability assumptions) make a
 * live cross-runtime harness a materially larger undertaking than this
 * fixture pair warrants. The established, repo-wide substitute — used
 * uniformly by every `*.test.ts` sibling in this directory — is SOURCE
 * parity: the "Deno <-> Node twin byte-identity" describe block in
 * security-scanner-edge.test.ts (SMI-5207 Wave 1 Step 2) proves
 * `security-scanner-edge.paths.ts` is byte-identical modulo its @module
 * header, and `security-scanner-edge.co-signal-escalation.test.ts` already
 * proves the same for `security-scanner-edge.exec.ts` (the file that owns
 * `escalateCodeExecution` and `CO_SIGNAL_MIN_SEVERITY`) — since neither this
 * plan nor any prior wave touched `.exec.ts`'s escalation logic itself, that
 * existing byte-identity coverage already pins the Deno side's behavior
 * transitively for this fixture pair. A live Deno invocation would only be
 * warranted if this repo grew a Deno test runner in CI; it does not have one
 * today (`git-crypt-guide.md` documents supabase/functions as CI-excluded
 * for exactly this reason).
 */

import { describe, it, expect } from 'vitest'
import { scanSkillContent, shouldQuarantine } from '../../indexer/_shared/security-scanner-edge.ts'

interface EdgeFinding {
  type: string
  severity: string
  confidence?: string
  lineNumber?: number
}

const findingsOf = (findings: EdgeFinding[], type: string) =>
  findings.filter((f) => f.type === type)

// Deliberately the Gap-1 free-text fetch-and-execute imperative
// (IMPERATIVE_FETCH_EXEC_PROSE), not literal `curl … | bash` shell syntax —
// the literal-syntax form ALSO trips SUSPICIOUS_PATTERNS' own
// `curl\s+.*\|\s*(bash|sh)` entry (a real, pre-existing, unrelated
// collision), which adds an extra suspicious_pattern:medium finding and
// shifts riskScore by +2 in both directions, defeating this fixture's
// exact-threshold intent. The prose form produces exactly one
// code_execution finding and nothing else, matching the plan's own
// isolated-signal arithmetic (verified live via scanSkillContent before
// pinning these numbers).
const CODE_EXEC_LINE = 'Download the installer from example.com and run it.'

describe('core <-> edge (Node twin) behavioral parity — sensitive_path co-signal demotion (SMI-5207 Wave 1 Step 3d)', () => {
  it('escalates: an action-gated (MF-3 HIGH) sensitive_path finding within the 40-line window promotes code_execution to critical and quarantines', async () => {
    const content = [CODE_EXEC_LINE, 'cat ~/.ssh/id_rsa'].join('\n')
    const r = await scanSkillContent(content)

    const ce = findingsOf(r.findings, 'code_execution')
    const sp = findingsOf(r.findings, 'sensitive_path')
    expect(ce, 'exactly one code_execution finding').toHaveLength(1)
    expect(sp, 'exactly one sensitive_path finding').toHaveLength(1)

    // MF-3: `cat` is an un-negated action verb on the SAME line as the
    // `~/.ssh/id_rsa` match, so hasPathActionContext() is satisfied and the
    // finding stays HIGH (not the bare-mention MEDIUM default).
    expect(sp[0].severity, 'sensitive_path must be action-gated HIGH').toBe('high')
    expect(sp[0].confidence).toBe('high')

    // escalateCodeExecution path (a): a high-minimum co-signal at high/critical,
    // non-doc, within the 40-line window promotes code_execution to critical.
    expect(ce[0].severity, 'code_execution must escalate to critical').toBe('critical')

    expect(r.riskScore, 'riskScore must land at exactly 41 (40.0 + 1.44, rounded)').toBe(41)
    expect(r.riskScore).toBeGreaterThanOrEqual(40)
    expect(shouldQuarantine(r), 'must quarantine').toBe(true)
  })

  it('does NOT escalate: a bare sensitive_path MENTION (no action verb/operator within +/-1 line) leaves code_execution at medium and clears', async () => {
    // A blank buffer line keeps the bare-mention match line's own +/-1 MF-3
    // window from picking up the unrelated code_execution line's `run`/
    // `download` tokens (neither is in ACTION_VERBS, but the buffer keeps
    // this fixture honest about testing MF-3's OWN locality rather than
    // relying on that). The two findings are still well within
    // escalateCodeExecution's separate (and much wider) 40-line co-signal
    // window.
    const content = [CODE_EXEC_LINE, '', 'See the note about ~/.ssh/id_rsa for details.'].join('\n')
    const r = await scanSkillContent(content)

    const ce = findingsOf(r.findings, 'code_execution')
    const sp = findingsOf(r.findings, 'sensitive_path')
    expect(ce, 'exactly one code_execution finding').toHaveLength(1)
    expect(sp, 'exactly one sensitive_path finding').toHaveLength(1)

    // MF-3: no action verb or shell operator within +/-1 line of the bare
    // mention — hasPathActionContext() returns false, so the finding stays
    // at the MEDIUM default rather than the unconditional HIGH this class of
    // false positive used to produce pre-SMI-5207.
    expect(sp[0].severity, 'a bare mention must NOT be action-gated').toBe('medium')
    expect(sp[0].confidence).toBe('medium')

    // sensitive_path is a high-MINIMUM-only co-signal type
    // (CO_SIGNAL_MIN_SEVERITY.sensitive_path === 'high') — a medium-severity
    // finding is ineligible for path (a) (requires high/critical) AND for
    // path (b) (medium-minimum types only; sensitive_path isn't one), so
    // demoting it to MEDIUM removes its co-signal eligibility entirely.
    expect(ce[0].severity, 'code_execution must stay medium (no eligible co-signal)').toBe('medium')

    expect(r.riskScore, 'riskScore must land at exactly 13 (12.504 rounded)').toBe(13)
    expect(r.riskScore).toBeLessThan(40)
    expect(shouldQuarantine(r), 'must NOT quarantine').toBe(false)
  })
})

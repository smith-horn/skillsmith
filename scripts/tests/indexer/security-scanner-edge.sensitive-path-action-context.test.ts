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
import { scanSensitivePaths } from '../../indexer/_shared/security-scanner-edge.paths.ts'
import { analyzeMarkdownContext } from '../../indexer/_shared/security-scanner-edge.context.ts'
import { assignmentHasRealValue } from '../../indexer/_shared/security-scanner-edge.value-gate.ts'

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

/**
 * SMI-6441 Wave 2 (Node twin) — the MF-4b weak-password veto. R-2 closed: the
 * 2-token documentation-label carve-out no longer swallows a value where one
 * token is a known common password
 * (security-scanner-edge.weak-passwords.ts, a generated lexicon). Mirrors
 * core's packages/core/tests/security/sensitive-path-adversarial-review.test.ts
 * "SMI-6441 Wave 2" describe block byte-for-byte in fixture content, using
 * this suite's own local severityOf() (built on this file's own imports of
 * scanSensitivePaths/analyzeMarkdownContext, not by importing the sibling
 * test file's helper) so the direct-scan-layer coverage exists in this file
 * too, not just at the full-pipeline (scanSkillContent) layer above.
 */
describe('SMI-6441 Wave 2 (Node twin, action-context suite) — MF-4b weak-password veto', () => {
  /** Highest sensitive_path severity on `content` ('none' when nothing fires). */
  function severityOf(content: string): string {
    const lines = content.split('\n')
    const contexts = analyzeMarkdownContext(content)
    const findings = scanSensitivePaths(lines, contexts).filter((f) => f.type === 'sensitive_path')
    if (findings.length === 0) return 'none'
    return findings.some((f) => f.severity === 'high') ? 'high' : findings[0].severity
  }

  describe('(a) must fire HIGH — R-2 closed', () => {
    it.each([
      ['two common passwords, no ambiguity', 'password: monkey dragon'],
      ['non-word common password — highest-precision sub-case', 'password: qwerty ninja'],
      ['different assignment key, same shape', 'secrets: letmein sunshine'],
      ['third assignment key', 'credentials: dragon shadow'],
      ['YAML next-line block form reaches the same rule', 'password:\n  monkey dragon'],
      [
        'segmentation: one prose segment + one credential segment (round-8 invariant holds under the veto)',
        'credentials: rotation policy password: monkey dragon',
      ],
    ])('%s', (_label, content) => {
      expect(severityOf(content)).toBe('high')
    })
  })

  describe('(b) must NOT regress — MEDIUM keeplist (tokens confirmed absent from the lexicon)', () => {
    it.each([
      ['highest-risk new FP shape', 'credentials: access token'],
      ["adjacent to allowlist entry 1's 1Password class", 'credentials: password manager'],
      ['pins "key"/"management" absent from lexicon', 'secrets: key management'],
      ['pins "rotation"/"schedule" absent from lexicon', 'secrets: rotation schedule'],
      ['pins "master", a top-1000 password, absent from lexicon', 'credentials: master key'],
      // This fixture has moved twice. SMI-5207 accepted it as the R-2
      // residual (MEDIUM). An interim SMI-6441 draft using tokens.some(...)
      // moved it to must-fire, since "horse" alone is a known common
      // password. The final tokens.every(...) predicate returns it here — R-2
      // is only PARTIALLY closed: pairing one common password with one
      // ordinary word still clears to MEDIUM, because some() was found to
      // reopen the SMI-5207 documentation false-positive class unboundedly.
      [
        'R-2 PARTIALLY closed by SMI-6441 — one common password + one ordinary word stays MEDIUM under the every() predicate',
        'password: horse staple',
      ],
      // Regression guard for the exact FP class the every() predicate change
      // was made to close — each of these fired HIGH under the interim
      // some() predicate and must clear to MEDIUM under every().
      ['every() FP-class guard', 'credentials: security policy'],
      ['every() FP-class guard', 'credentials: command reference'],
      ['every() FP-class guard', 'secrets: cloud provider'],
      ['every() FP-class guard', 'credentials: help center'],
      ['every() FP-class guard', 'credentials: active profile'],
      ['every() FP-class guard', 'secrets: mobile app'],
      ['every() FP-class guard', 'credentials: java client'],
      ['every() FP-class guard', 'credentials: support matrix'],
    ])('%s', (_label, content) => {
      expect(severityOf(content)).toBe('medium')
    })
  })

  describe('(c) residuals pinned so a future wave cannot silently change them', () => {
    it('R-1 unchanged: single token stays HIGH', () => {
      expect(severityOf('password: swordfish')).toBe('high')
    })

    it('R-1 unchanged: undecidable by construction', () => {
      expect(severityOf('secret: cryptography')).toBe('high')
    })

    it('R-3 deliberately NOT closed — the veto does not extend to the stopword rule', () => {
      expect(severityOf('password: the correct horse battery')).toBe('medium')
    })

    it('sentence path — proves the veto did not leak upward', () => {
      expect(severityOf('password: never paste your password into chat')).toBe('medium')
    })

    // R-2's remaining half. SUBSTITUTION: the plan doc's own Step 3(c)
    // literal ("velvet hammer") is wrong — both words ARE present in the
    // generated lexicon (verified live), so it would wrongly fire HIGH under
    // the veto. "lantern"/"trellis" are confirmed absent from both the
    // lexicon and PROSE_STOPWORDS.
    it('R-2 remaining half — two ordinary words, neither a common password (undecidable)', () => {
      expect(severityOf('password: lantern trellis')).toBe('medium')
    })

    it('3 tokens -> carve-out never applies, unchanged by SMI-6441', () => {
      expect(severityOf('password: lantern trellis orbit92')).toBe('high')
    })
  })

  describe('(d) seam: options.weakPasswordVeto is a pure per-call parameter (P-5)', () => {
    it('(d.1) correctness: veto:false reproduces the pre-6441 verdict for every (a) fixture', () => {
      const fixtures: Array<string[]> = [
        ['password: monkey dragon'],
        ['password: qwerty ninja'],
        ['secrets: letmein sunshine'],
        ['credentials: dragon shadow'],
        ['password:', '  monkey dragon'],
        ['credentials: rotation policy password: monkey dragon'],
      ]
      for (const lines of fixtures) {
        expect(assignmentHasRealValue(lines, 0, { weakPasswordVeto: false })).toBe(false)
      }
    })

    // The P-5 audit claims options.weakPasswordVeto is a pure parameter and
    // never module state, asserted in prose only. Alternates the option
    // across calls on the SAME module instance — any module-level caching of
    // the option (or a veto-conditioned derived value) makes one of these
    // flip. The seam is byte-identical across all three substrates, so a leak
    // introduced in this twin port must fail here too.
    it('(d.2) no cross-call leakage — the option must not be sticky across alternating calls', () => {
      const lines = ['password: monkey dragon']
      expect(assignmentHasRealValue(lines, 0, { weakPasswordVeto: false })).toBe(false) // pre-6441
      expect(assignmentHasRealValue(lines, 0)).toBe(true) // default: veto on
      expect(assignmentHasRealValue(lines, 0, { weakPasswordVeto: false })).toBe(false) // must NOT be sticky
      expect(assignmentHasRealValue(lines, 0, { weakPasswordVeto: true })).toBe(true)
      expect(assignmentHasRealValue(lines, 0)).toBe(true)

      const mediumLines = ['credentials: rotation policy']
      expect(assignmentHasRealValue(mediumLines, 0, { weakPasswordVeto: false })).toBe(false)
      expect(assignmentHasRealValue(mediumLines, 0)).toBe(false)
      expect(assignmentHasRealValue(mediumLines, 0, { weakPasswordVeto: false })).toBe(false)
      expect(assignmentHasRealValue(mediumLines, 0, { weakPasswordVeto: true })).toBe(false)
      expect(assignmentHasRealValue(mediumLines, 0)).toBe(false)
    })
  })
})

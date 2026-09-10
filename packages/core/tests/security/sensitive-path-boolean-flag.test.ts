/**
 * SMI-6505 — embedded-key boolean-flag carve-out in the MF-4 value gate.
 *
 * `allow_credentials=True` (a FastAPI/Starlette CORS middleware flag) scored HIGH,
 * which makes SecurityScanner compute `passed = false`, which makes the install
 * service REJECT the install. There is no allowlist in that path, so any skill
 * documenting FastAPI CORS setup was uninstallable at a risk score of 1/100.
 *
 * The fix keys on the ASSIGNMENT KEY, not the value alone: `credentials` matched
 * inside `allow_credentials` only because CREDENTIALS_ASSIGN_PATTERN has no left
 * boundary, and an embedded keyword assigned a bare boolean is a configuration
 * flag. It is deliberately NOT a prefix-boundary fix — adding `\b` there would
 * also stop matching `AWS_CREDENTIALS=hunter2` (see SMI-6508).
 *
 * `assignmentHasRealValue` returns TRUE for "assigns a real credential" (→ HIGH)
 * and FALSE for "reads as prose" (→ MEDIUM).
 *
 * THE EVASION GUARDS BELOW ARE LOAD-BEARING. `BOOLEAN_FLAG_VALUE` is anchored at
 * both ends because the value span runs to the next assignment key or EOL, so any
 * relaxation that leaves part of the span unexamined is where a real credential
 * hides. Two such relaxations were each measured and rejected; the cases that
 * would have been fixed by them are pinned here as residuals, and the bypasses
 * they would have opened are pinned as must-stay-HIGH.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import type { SecurityFinding } from '../../src/security/scanner/types.js'
import { assignmentHasRealValue } from '../../src/security/scanner/SecurityScanner.value-gate.js'

const FASTAPI_DOC_LINE =
  '  - user: "Check FastAPI CORS setup" → verify origins when allow_credentials=True'

/** [line, expectRealCredential, why] */
const CASES: Array<[string, boolean, string]> = [
  // --- the reported false positive, in its real formatting variants ---
  [FASTAPI_DOC_LINE, false, 'the reported live security-fastapi line'],
  ['    allow_credentials=True,', false, 'multi-line call — the common real code shape'],
  ['    allow_credentials = False)', false, 'spaces around =, trailing paren'],
  ['allow_credentials: true', false, 'YAML/colon form'],
  ['allow_credentials=TRUE', false, 'case-insensitive'],
  ['    allow_credentials=True;', false, 'semicolon terminator'],
  ['    allow_credentials=True]', false, 'bracket terminator'],
  [
    '    allow_credentials=True}',
    false,
    'brace terminator — every delimiter the class accepts is pinned',
  ],

  // --- accepted residuals: part of the span would have to go unexamined ---
  [
    'app.add_middleware(CORSMiddleware, allow_credentials=True, allow_methods=["*"])',
    true,
    'RESIDUAL: single-line multi-arg call. Fixing needs token-termination, which opens the comma evasion below',
  ],
  [
    '    allow_credentials=True,  # allow cookies',
    true,
    'RESIDUAL: inline comment. Fixing needs a comment branch, which opens the comment evasion below',
  ],

  // --- evasion guards: these are WHY the regex is anchored at both ends ---
  [
    'my_credentials=true, Tr0ub4dor&3',
    true,
    'EVASION GUARD: a token-terminated regex returns MEDIUM here and hides the credential',
  ],
  [
    'my_credentials=true # Tr0ub4dor&3',
    true,
    'EVASION GUARD: a trailing-comment branch returns MEDIUM here and hides the credential',
  ],
  ['my_credentials=true, hunter2', true, 'EVASION GUARD: same class, unquoted weak value'],

  // --- bare keys must be untouched: the key is the discriminator ---
  ['credentials: True', true, 'bare key — a value-only rule would have downgraded this'],
  ['password: True', true, 'bare key'],
  ['secrets: true', true, 'bare key; secrets carries its own \\b so it can never be embedded'],

  // --- the SMI-6508 shape must keep flagging ---
  ['AWS_CREDENTIALS=hunter2', true, 'embedded key, real value — must stay HIGH (SMI-6508)'],
  ['allow_credentials="true"', true, 'embedded key, QUOTED boolean — a string value, not a flag'],
  [
    'credentials: "true"',
    true,
    'bare key, quoted boolean — HIGH via two independent routes: the key is not embedded, and the quotes defeat the anchored match anyway',
  ],

  // --- the accepted cost, pinned so it stays deliberate and visible ---
  ['DB_PASSWORD=true', false, 'ACCEPTED COST: embedded credential-ish key, boolean value'],

  // --- predecessor-class residuals: isEmbeddedKey only treats [A-Za-z0-9_] as
  // embedding, matching the reported underscore defect exactly. Both of these
  // therefore read as BARE keys and stay HIGH. Pinned, not silent. ---
  [
    'allow-credentials=true',
    true,
    'RESIDUAL: kebab-case. A real shape (Spring Boot / YAML use `allow-credentials`), left out of scope for the same reason as `yes` — plausible but unobserved. Widening isEmbeddedKey to include `-` would fix it and opens no evasion, since the both-ends anchor is what guards that. Do it against a live example',
  ],
  [
    'obj.credentials=true',
    true,
    'RESIDUAL, and arguably correct: a dotted attribute access names a property literally called `credentials`, so treating it as a bare key is the conservative reading',
  ],

  // --- rejected scope: YAML truthy spellings are NOT in the boolean set ---
  ['allow_credentials=yes', true, 'pins the rejected YAML scope — `yes` stays HIGH'],
  [
    'allow_credentials=on',
    false,
    'PRE-EXISTING, not this rule: `on` is a PROSE_STOPWORD, so the stopword branch already downgraded it. BOOLEAN_FLAG_VALUE does not match `on`, so the guard is a no-op here — verified against the lexicon, not assumed',
  ],
  ['allow_credentials=off', false, 'PRE-EXISTING: same, `off` is a PROSE_STOPWORD'],

  // --- unchanged prior behaviour ---
  ['password: hunter2', true, 'unchanged'],
  ['password: monkey dragon', true, 'unchanged — SMI-6441 MF-4b veto'],
  ['credentials: rotation policy', false, 'unchanged — 2-token doc label'],
  ['password: horse staple', false, "unchanged — SMI-6441's deliberate residual (ADR-149)"],
  [
    'allow_credentials=True, password: hunter2',
    true,
    'a later segment holds a real credential — segmentation still wins',
  ],
]

describe('SMI-6505 — embedded-key boolean flag', () => {
  it.each(CASES)('%s → realCredential=%s (%s)', (line, expected) => {
    expect(assignmentHasRealValue([line], 0)).toBe(expected)
  })

  it('the carve-out is independent of the MF-4b veto option', () => {
    // The guard runs before isProseValue and never consults weakPasswordVeto, so
    // toggling that option must not move any of these verdicts.
    for (const [line, expected] of CASES) {
      expect(assignmentHasRealValue([line], 0, { weakPasswordVeto: true })).toBe(
        assignmentHasRealValue([line], 0)
      )
      if (line !== 'password: monkey dragon') {
        expect(assignmentHasRealValue([line], 0, { weakPasswordVeto: false })).toBe(expected)
      }
    }
  })

  it('RESIDUAL: the YAML next-line path is not covered by the carve-out', () => {
    // The trailing-bare-key branch calls isProseValue directly, so an embedded key
    // taking its boolean from the next line still reads HIGH. Documented, narrow,
    // and pinned so a future change to that branch is a deliberate one.
    expect(assignmentHasRealValue(['my_credentials:', '  true'], 0)).toBe(true)
    // A bare key on the same path is unambiguously correct at HIGH.
    expect(assignmentHasRealValue(['credentials:', '  true'], 0)).toBe(true)
  })

  describe('end to end — the install-blocking symptom is gone', () => {
    let scanner: SecurityScanner
    beforeEach(() => {
      scanner = new SecurityScanner()
    })

    const highSensitivePaths = (fs: SecurityFinding[]) =>
      fs.filter(
        (f) => f.type === 'sensitive_path' && (f.severity === 'high' || f.severity === 'critical')
      )

    it('the reported line produces no high/critical sensitive_path finding', () => {
      const report = scanner.scan('t', FASTAPI_DOC_LINE)
      expect(highSensitivePaths(report.findings)).toHaveLength(0)
    })

    it('a real credential on an embedded key still produces one', () => {
      const report = scanner.scan('t', 'AWS_CREDENTIALS=hunter2')
      expect(highSensitivePaths(report.findings).length).toBeGreaterThan(0)
    })
  })
})

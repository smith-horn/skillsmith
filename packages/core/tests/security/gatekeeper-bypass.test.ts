/**
 * SMI-6033 Wave 2 (Gap 5): xattr Gatekeeper-bypass detector.
 *
 * `xattr -c` (clear ALL extended attributes) and
 * `xattr -d com.apple.quarantine` (delete just the quarantine attribute,
 * with or without a combined `-r`) strip macOS's "downloaded from the
 * internet" Gatekeeper warning from an unsigned binary. Unlike the chmod
 * compound signal (SecurityScanner.compound.ts's scanChmodFetchCompound),
 * this signal is standalone-critical — no fetch-correlation co-signal is
 * required, per the plan's §9 reconciliation policy ("essentially no
 * legitimate use case in a skill-install context").
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import type { SecurityFinding } from '../../src/security/scanner/types.js'

const gb = (fs: SecurityFinding[]) => fs.filter((f) => f.type === 'gatekeeper_bypass')

describe('SMI-6033 Wave 2 xattr Gatekeeper-bypass', () => {
  let scanner: SecurityScanner
  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  // Standalone-critical: no correlation required, unlike chmod.
  it.each([
    ['xattr -c (clear all)', 'xattr -c /Applications/EvilApp.app'],
    ['xattr -cr (clear all, recursive)', 'xattr -cr /Applications/EvilApp.app'],
    ['xattr -d com.apple.quarantine', 'xattr -d com.apple.quarantine /Applications/EvilApp.app'],
    [
      'xattr -dr com.apple.quarantine (combined recursive)',
      'xattr -dr com.apple.quarantine /Applications/EvilApp.app',
    ],
    [
      'xattr -rd com.apple.quarantine (combined, reversed order)',
      'xattr -rd com.apple.quarantine /Applications/EvilApp.app',
    ],
    [
      'xattr -r -d com.apple.quarantine (separate flag tokens)',
      'xattr -r -d com.apple.quarantine /Applications/EvilApp.app',
    ],
    ['sudo xattr -d com.apple.quarantine', 'sudo xattr -d com.apple.quarantine ./App.app'],
  ])('fires standalone-critical: %s', (_label, content) => {
    const report = scanner.scan('t', content)
    const f = gb(report.findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f[0].severity).toBe('critical')
    expect(report.passed).toBe(false)
    expect(report.riskScore).toBeGreaterThanOrEqual(40)
  })

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

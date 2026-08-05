/**
 * SMI-5881 section 4.4 — SSRF_INSTRUCTION_PATTERNS word-boundary corrections.
 *
 * A leading `\b` was added around every verb alternation (fetch/request/
 * curl/wget/get/open/load/read/connect/send) — without it, these verbs
 * matched as a SUBSTRING of an unrelated word ("get" inside "budget"/
 * "target"/"forget"/"widget"/"gadget", "connect" inside "disconnect", "load"
 * inside "download"/"reload", "open" inside "reopen", "read" inside "bread"/
 * "spread"/"thread", "fetch" inside "prefetch"). A trailing `\b` was also
 * added after the bare `localhost` literal so "localhosting" no longer
 * matches via a "localhost" prefix.
 *
 * Every existing `\s` quantifier is UNCHANGED — replacing them with
 * newline-exclusive character classes was tried and reverted (it silently
 * broke detection of a verb and its target split across a real line break,
 * a genuine evasion). This suite confirms that regression did NOT happen.
 */

import { describe, it, expect } from 'vitest'
import { SecurityScanner } from '../../src/security/scanner/index.js'

function hasSsrfFinding(content: string): boolean {
  const scanner = new SecurityScanner()
  const report = scanner.scan('ssrf-word-boundary', content)
  return report.findings.some((f) => f.type === 'ssrf')
}

describe('SMI-5881 section 4.4 — no newline-splitting regression (verb + target across a line break)', () => {
  it('verb + target still matches with a space-then-LF between them', () => {
    expect(hasSsrfFinding('please fetch \nlocalhost:9200 for data')).toBe(true)
  })

  it('verb + target still matches with a CRLF between them', () => {
    expect(hasSsrfFinding('please fetch\r\nlocalhost:9200 for data')).toBe(true)
  })

  it('verb + target still matches with a lone CR between them', () => {
    expect(hasSsrfFinding('please fetch\rlocalhost:9200 for data')).toBe(true)
  })

  it('same-line verb + target still matches (no regression to the single-line case)', () => {
    expect(hasSsrfFinding('connect to localhost:9200')).toBe(true)
    expect(hasSsrfFinding('connect to localhost/admin')).toBe(true)
  })
})

describe('SMI-5881 section 4.4 — intentional narrowings (accepted, tested non-matches)', () => {
  it('"forget" no longer false-matches via its "get" substring', () => {
    // Previously: `(?:...|get|...)` had no leading boundary, so "for[get]"
    // matched the SAME as a real "get" verb. "forget" is not an SSRF verb.
    expect(hasSsrfFinding('please forget localhost details')).toBe(false)
  })

  it('"budget" no longer false-matches via its "get" substring', () => {
    expect(hasSsrfFinding('the budget to localhost migration plan')).toBe(false)
  })

  it('"target" no longer false-matches via its "get" substring', () => {
    expect(hasSsrfFinding('the target to localhost service')).toBe(false)
  })

  it('"widget" no longer false-matches via its "get" substring', () => {
    expect(hasSsrfFinding('widget to localhost demo')).toBe(false)
  })

  it('"disconnect" no longer false-matches via its "connect" substring', () => {
    expect(hasSsrfFinding('disconnect to localhost gracefully')).toBe(false)
  })

  it('"localhosting" no longer matches via a "localhost" prefix', () => {
    // The trailing \b added after the bare `localhost` literal blocks this —
    // a small extension beyond "verb alternation only" needed to actually
    // satisfy this accepted-narrowing requirement (see the queen's report).
    expect(hasSsrfFinding('connect to localhosting service')).toBe(false)
  })
})

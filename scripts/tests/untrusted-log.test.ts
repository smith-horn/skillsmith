/**
 * logUntrusted (SMI-7164): PR-body text is printed inside a ::stop-commands:: window so GitHub
 * Actions does not run workflow commands embedded in it.
 */
import { describe, expect, it } from 'vitest'

const { logUntrusted } = (await import('../lib/untrusted-log.mjs')) as {
  logUntrusted: (text: string, opts?: { log?: (l: string) => void; token?: string }) => void
}

const capture = (text: string) => {
  const lines: string[] = []
  logUntrusted(text, { log: (l) => lines.push(l) })
  return lines
}

describe('logUntrusted', () => {
  it('prints the text between a stop-commands line and its matching resume token', () => {
    const lines = capture('reason\n::error::forged')
    expect(lines).toHaveLength(3)
    const m = /^::stop-commands::([0-9a-f]{32})$/.exec(lines[0])
    expect(m).not.toBeNull()
    expect(lines[1]).toBe('reason\n::error::forged')
    expect(lines[2]).toBe(`::${m![1]}::`)
  })

  it('uses a different token on every call, so the text cannot guess it', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => capture('x')[0]))
    expect(tokens.size).toBe(20)
  })
})

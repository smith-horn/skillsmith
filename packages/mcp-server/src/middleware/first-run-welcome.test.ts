/**
 * @fileoverview Tests for the first-run welcome message middleware — SMI-5573
 *
 * Mirrors the test shape of `telemetry-consent.test.ts`'s
 * `annotateResponseWithConsent` suite: a `makeEnvelope` helper builds a
 * minimal MCP `CallToolResult`-shaped object, and `_resetPendingWelcomeForTests`
 * is called in `beforeEach`/`afterEach` so every test starts with a clean
 * process-level singleton.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  setPendingWelcome,
  hasPendingWelcome,
  annotateResponseWithWelcome,
  _resetPendingWelcomeForTests,
} from './first-run-welcome.js'

/** Minimal MCP CallToolResult-shaped envelope with a JSON-serialized text block. */
function makeEnvelope(body: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    ...(isError ? { isError: true } : {}),
  } as CallToolResult
}

function parseFirstText(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0] as { type: string; text: string }
  return JSON.parse(first.text) as Record<string, unknown>
}

beforeEach(() => {
  _resetPendingWelcomeForTests()
})

afterEach(() => {
  _resetPendingWelcomeForTests()
})

// ============================================================================
// (a) No pending message — passthrough
// ============================================================================

describe('annotateResponseWithWelcome — no pending message', () => {
  it('returns the response unchanged (same reference) when nothing is pending', () => {
    expect(hasPendingWelcome()).toBe(false)

    const envelope = makeEnvelope({ result: 'ok' })
    const out = annotateResponseWithWelcome(envelope)

    expect(out).toBe(envelope)
    const parsed = parseFirstText(out)
    expect(parsed).not.toHaveProperty('welcome_message')
    expect(parsed).not.toHaveProperty('tier1_install_failures')
  })
})

// ============================================================================
// (b) Pending message + successful response — spliced, then consumed
// ============================================================================

describe('annotateResponseWithWelcome — pending message + success', () => {
  it('splices welcome_message and tier1_install_failures into the response', () => {
    setPendingWelcome('Welcome to Skillsmith!', ['author/skill-a', 'author/skill-b'])
    expect(hasPendingWelcome()).toBe(true)

    const envelope = makeEnvelope({ result: 'ok' })
    const out = annotateResponseWithWelcome(envelope)

    const parsed = parseFirstText(out)
    expect(parsed.result).toBe('ok')
    expect(parsed.welcome_message).toBe('Welcome to Skillsmith!')
    expect(parsed.tier1_install_failures).toEqual(['author/skill-a', 'author/skill-b'])
  })

  it('splices an empty tier1_install_failures array when no installs failed', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])

    const envelope = makeEnvelope({ result: 'ok' })
    const out = annotateResponseWithWelcome(envelope)

    const parsed = parseFirstText(out)
    expect(parsed.tier1_install_failures).toEqual([])
  })

  it('clears the pending state after a successful splice', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])

    annotateResponseWithWelcome(makeEnvelope({ result: 'ok' }))

    expect(hasPendingWelcome()).toBe(false)
  })

  it('does not mutate the original response object', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])
    const envelope = makeEnvelope({ result: 'ok' })
    const originalText = (envelope.content[0] as { text: string }).text

    const out = annotateResponseWithWelcome(envelope)

    expect(out).not.toBe(envelope)
    expect((envelope.content[0] as { text: string }).text).toBe(originalText)
  })
})

// ============================================================================
// (c) One-shot — a second call after consumption does not re-splice
// ============================================================================

describe('annotateResponseWithWelcome — one-shot delivery', () => {
  it('does not splice again on a second successful call after consumption', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])

    const first = annotateResponseWithWelcome(makeEnvelope({ call: 1 }))
    expect(parseFirstText(first).welcome_message).toBe('Welcome to Skillsmith!')

    const secondEnvelope = makeEnvelope({ call: 2 })
    const second = annotateResponseWithWelcome(secondEnvelope)

    expect(second).toBe(secondEnvelope)
    const parsed = parseFirstText(second)
    expect(parsed).not.toHaveProperty('welcome_message')
    expect(parsed).not.toHaveProperty('tier1_install_failures')
  })
})

// ============================================================================
// (d) Error response — NOT consumed, next successful call still gets it
// ============================================================================

describe('annotateResponseWithWelcome — error response', () => {
  it('returns the error response unchanged and does not splice fields', () => {
    setPendingWelcome('Welcome to Skillsmith!', ['author/skill-a'])

    const errorEnvelope = makeEnvelope({ error: 'boom' }, true)
    const out = annotateResponseWithWelcome(errorEnvelope)

    expect(out).toBe(errorEnvelope)
    const parsed = parseFirstText(out)
    expect(parsed).not.toHaveProperty('welcome_message')
  })

  it('leaves the pending state intact after an error response', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])

    annotateResponseWithWelcome(makeEnvelope({ error: 'boom' }, true))

    expect(hasPendingWelcome()).toBe(true)
  })

  it('still delivers the welcome message on the next successful call after a prior error', () => {
    setPendingWelcome('Welcome to Skillsmith!', ['author/skill-a'])

    // First call fails (transient error) — must not consume the pending state.
    annotateResponseWithWelcome(makeEnvelope({ error: 'boom' }, true))
    expect(hasPendingWelcome()).toBe(true)

    // Second call succeeds — the message must still be delivered.
    const out = annotateResponseWithWelcome(makeEnvelope({ result: 'ok' }))
    const parsed = parseFirstText(out)
    expect(parsed.welcome_message).toBe('Welcome to Skillsmith!')
    expect(parsed.tier1_install_failures).toEqual(['author/skill-a'])
    expect(hasPendingWelcome()).toBe(false)
  })
})

// ============================================================================
// (e) Malformed / non-JSON content — untouched, state NOT consumed
// ============================================================================

describe('annotateResponseWithWelcome — malformed content', () => {
  it('returns the response unchanged when text is not valid JSON', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])

    const envelope: CallToolResult = {
      content: [{ type: 'text', text: 'not-valid-json{{' }],
    } as CallToolResult

    expect(() => annotateResponseWithWelcome(envelope)).not.toThrow()
    const out = annotateResponseWithWelcome(envelope)
    expect(out).toBe(envelope)
  })

  it('does not consume the pending state when JSON parsing fails', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])

    const envelope: CallToolResult = {
      content: [{ type: 'text', text: 'not-valid-json{{' }],
    } as CallToolResult

    annotateResponseWithWelcome(envelope)

    expect(hasPendingWelcome()).toBe(true)
  })

  it('still delivers the welcome message on a subsequent well-formed call', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])

    const malformed: CallToolResult = {
      content: [{ type: 'text', text: 'not-valid-json{{' }],
    } as CallToolResult
    annotateResponseWithWelcome(malformed)

    const out = annotateResponseWithWelcome(makeEnvelope({ result: 'ok' }))
    expect(parseFirstText(out).welcome_message).toBe('Welcome to Skillsmith!')
  })

  it('returns the response unchanged when content array is empty', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])
    const envelope: CallToolResult = { content: [] } as unknown as CallToolResult

    const out = annotateResponseWithWelcome(envelope)

    expect(out).toBe(envelope)
    expect(hasPendingWelcome()).toBe(true)
  })

  it('returns the response unchanged when the first content item is not type=text', () => {
    setPendingWelcome('Welcome to Skillsmith!', [])
    const envelope: CallToolResult = {
      content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }],
    } as unknown as CallToolResult

    const out = annotateResponseWithWelcome(envelope)

    expect(out).toBe(envelope)
    expect(hasPendingWelcome()).toBe(true)
  })
})

// ============================================================================
// setPendingWelcome / hasPendingWelcome direct coverage
// ============================================================================

describe('setPendingWelcome / hasPendingWelcome', () => {
  it('hasPendingWelcome reflects whether a message is currently queued', () => {
    expect(hasPendingWelcome()).toBe(false)
    setPendingWelcome('hi', [])
    expect(hasPendingWelcome()).toBe(true)
  })

  it('overwrites a previous pending message when called again before consumption', () => {
    setPendingWelcome('first message', ['a'])
    setPendingWelcome('second message', ['b', 'c'])

    const out = annotateResponseWithWelcome(makeEnvelope({ result: 'ok' }))
    const parsed = parseFirstText(out)

    expect(parsed.welcome_message).toBe('second message')
    expect(parsed.tier1_install_failures).toEqual(['b', 'c'])
  })

  it('does not share failure array identity with the caller-provided array', () => {
    const failures = ['author/skill-a']
    setPendingWelcome('hi', failures)
    failures.push('author/skill-b')

    const out = annotateResponseWithWelcome(makeEnvelope({ result: 'ok' }))
    expect(parseFirstText(out).tier1_install_failures).toEqual(['author/skill-a'])
  })
})

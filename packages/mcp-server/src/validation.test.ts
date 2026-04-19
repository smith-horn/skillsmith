/**
 * @fileoverview Unit tests for `safeParseOrError` helper.
 * @see SMI-4313: MCP tool-dispatch safeParse envelope refactor
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { safeParseOrError } from './validation.js'

const demoSchema = z.object({
  skillId: z.string().min(1),
  limit: z.number().int().positive().optional(),
  mode: z.enum(['fast', 'thorough']).optional(),
})

describe('safeParseOrError', () => {
  it('returns { ok: true, data } for valid input', () => {
    const result = safeParseOrError(demoSchema, { skillId: 'owner/repo', limit: 10 }, 'demo_tool')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ skillId: 'owner/repo', limit: 10 })
    }
  })

  it('returns { ok: false, response } for missing required field', () => {
    const result = safeParseOrError(demoSchema, {}, 'demo_tool')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.isError).toBe(true)
      expect(result.response.content).toHaveLength(1)
      const textEntry = result.response.content[0] as { type: string; text: string }
      expect(textEntry.type).toBe('text')
      const body = JSON.parse(textEntry.text) as {
        error: string
        tool: string
        issues: Array<{ path: string; message: string; code: string }>
      }
      expect(body.error).toBe('ValidationError')
      expect(body.tool).toBe('demo_tool')
      expect(body.issues.length).toBeGreaterThan(0)
      const skillIdIssue = body.issues.find((issue) => issue.path === 'skillId')
      expect(skillIdIssue).toBeDefined()
      expect(skillIdIssue?.code).toBeTruthy()
      expect(skillIdIssue?.message).toBeTruthy()
    }
  })

  it('returns { ok: false, response } for wrong type', () => {
    const result = safeParseOrError(demoSchema, { skillId: 'x', limit: 'abc' }, 'demo_tool')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const body = JSON.parse((result.response.content[0] as { text: string }).text) as {
        issues: Array<{ path: string; message: string; code: string }>
      }
      expect(body.issues.some((issue) => issue.path === 'limit')).toBe(true)
    }
  })

  it('returns { ok: false, response } for invalid enum value', () => {
    const result = safeParseOrError(demoSchema, { skillId: 'x', mode: 'bogus' }, 'demo_tool')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const body = JSON.parse((result.response.content[0] as { text: string }).text) as {
        issues: Array<{ path: string; message: string; code: string }>
      }
      expect(body.issues.some((issue) => issue.path === 'mode')).toBe(true)
    }
  })

  it('joins nested path segments with "." (zod path array → dotted string)', () => {
    const nested = z.object({
      outer: z.object({
        inner: z.string(),
      }),
    })
    const result = safeParseOrError(nested, { outer: {} }, 'nested_tool')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const body = JSON.parse((result.response.content[0] as { text: string }).text) as {
        issues: Array<{ path: string }>
      }
      expect(body.issues[0]?.path).toBe('outer.inner')
    }
  })

  it('threads the toolName through unchanged', () => {
    const result = safeParseOrError(demoSchema, {}, 'uninstall_skill')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const body = JSON.parse((result.response.content[0] as { text: string }).text) as {
        tool: string
      }
      expect(body.tool).toBe('uninstall_skill')
    }
  })

  it('matches the documented envelope shape (inline snapshot)', () => {
    const result = safeParseOrError(demoSchema, {}, 'demo_tool')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const body = JSON.parse((result.response.content[0] as { text: string }).text) as {
        error: string
        tool: string
        issues: Array<{ path: string; message: string; code: string }>
      }
      // Guard against silent drift back to stringified ZodError.message.
      expect(body).toMatchInlineSnapshot(
        {
          issues: expect.any(Array),
        },
        `
        {
          "error": "ValidationError",
          "issues": Any<Array>,
          "tool": "demo_tool",
        }
      `
      )
      // Each issue must have the documented keys
      for (const issue of body.issues) {
        expect(issue).toEqual(
          expect.objectContaining({
            path: expect.any(String),
            message: expect.any(String),
            code: expect.any(String),
          })
        )
      }
    }
  })
})

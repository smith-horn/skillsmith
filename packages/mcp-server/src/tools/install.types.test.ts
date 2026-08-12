/**
 * @fileoverview Tests for installInputSchema's `client`/`alsoLink` enum.
 *
 * SMI-5982 (Wave 6) audit finding: `client`/`alsoLink` in installInputSchema
 * used to hardcode a stale 5-value literal enum (`claude-code | cursor |
 * copilot | windsurf | agents`) that predated `opencode`/`hermes`
 * (SMI-5456) and `grok` (SMI-5697) — since a `z.enum([...])` literal is not
 * derived from the `ClientId` type, the compiler never caught this drift,
 * and `installInputSchema.safeParse()` silently REJECTED `client:
 * "opencode"` / `"hermes"` / `"grok"` over MCP even though the CLI fully
 * supported them. Fixed by deriving the enum from `CLIENT_IDS`
 * (`@skillsmith/core/install`) — this file guards against the same class of
 * drift recurring silently.
 */
import { describe, expect, it } from 'vitest'
import { CLIENT_IDS } from '@skillsmith/core/install'
import { installInputSchema } from './install.types.js'
import { installTool } from './install.tool.js'

describe('installInputSchema client/alsoLink enum (SMI-5982 Wave 6)', () => {
  it.each([...CLIENT_IDS])(
    'accepts client=%s (every current ClientId, not just the original 5)',
    (client) => {
      const result = installInputSchema.safeParse({ skillId: 'author/name', client })
      expect(result.success).toBe(true)
    }
  )

  it('accepts antigravity specifically (the new ClientId this wave adds)', () => {
    const result = installInputSchema.safeParse({ skillId: 'author/name', client: 'antigravity' })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown client value', () => {
    const result = installInputSchema.safeParse({ skillId: 'author/name', client: 'emacs' })
    expect(result.success).toBe(false)
  })

  it('alsoLink accepts every current ClientId too, including opencode/hermes/grok/antigravity', () => {
    const result = installInputSchema.safeParse({
      skillId: 'author/name',
      alsoLink: ['opencode', 'hermes', 'grok', 'antigravity'],
    })
    expect(result.success).toBe(true)
  })

  it('alsoLink rejects an unknown client value', () => {
    const result = installInputSchema.safeParse({
      skillId: 'author/name',
      alsoLink: ['emacs'],
    })
    expect(result.success).toBe(false)
  })

  it('the advertised installTool JSON-schema enum stays in sync with CLIENT_IDS too (same drift class, different file)', () => {
    const properties = installTool.inputSchema.properties
    expect(properties.client.enum).toEqual([...CLIENT_IDS])
    expect(properties.alsoLink.items.enum).toEqual([...CLIENT_IDS])
  })
})

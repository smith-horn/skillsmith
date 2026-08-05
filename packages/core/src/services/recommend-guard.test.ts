/**
 * @fileoverview Unit tests for the shared empty-derived-stack guidance string
 *   (SMI-5896 Wave 3 Step 2). Both CLI `recommend` and MCP `skill_recommend`
 *   surface this exact string so their empty-stack messaging can't drift.
 * @module @skillsmith/core/services/recommend-guard.test
 */
import { describe, expect, it } from 'vitest'

import { buildEmptyStackGuidance } from './recommend-guard.js'

describe('buildEmptyStackGuidance (SMI-5896 Wave 3 Step 2)', () => {
  it('returns a non-empty string', () => {
    const guidance = buildEmptyStackGuidance()
    expect(typeof guidance).toBe('string')
    expect(guidance.length).toBeGreaterThan(0)
  })

  it('explains the empty stack is a legitimate under-detection, not a backend fault', () => {
    const guidance = buildEmptyStackGuidance()
    expect(guidance).toContain('No technology stack could be derived')
  })

  it('guides the caller toward providing context or an installed-skills list', () => {
    const guidance = buildEmptyStackGuidance()
    expect(guidance.toLowerCase()).toContain('project context')
    expect(guidance.toLowerCase()).toContain('installed')
  })

  it('is deterministic (identical wording every call) so CLI and MCP never drift apart', () => {
    expect(buildEmptyStackGuidance()).toBe(buildEmptyStackGuidance())
  })
})

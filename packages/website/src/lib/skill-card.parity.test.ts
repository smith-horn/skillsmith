/**
 * SMI-5178 / SMI-5366 parity guard: COMPAT_LABELS in skill-card.ts must stay in
 * sync with the canonical COMPATIBILITY_LABELS map in @skillsmith/core.
 *
 * Source of truth: packages/core/src/compatibility/slugs.ts (COMPATIBILITY_LABELS).
 * The website client bundle CANNOT import @skillsmith/core at runtime, so this map
 * is duplicated in skill-card.ts and this test is the enforcement boundary.
 *
 * The source-of-truth guard for core's own map lives at:
 *   scripts/tests/indexer/compatibility-slug-parity.test.ts
 *
 * Pattern: follows the precedent of license-label.parity.test.ts (SMI-5337 retro).
 * When the canonical core map changes, update COMPAT_LABELS in skill-card.ts and
 * the EXPECTED constant below in lockstep.
 */

import { describe, it, expect } from 'vitest'
import { COMPAT_LABELS } from './skill-card'

// Hardcoded canonical contract — derived from packages/core/src/compatibility/slugs.ts.
// Do NOT derive this from COMPAT_LABELS itself; that would make the test circular.
const EXPECTED: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  codex: 'Codex',
  gemini: 'Gemini',
}

describe('COMPAT_LABELS — parity with core COMPATIBILITY_LABELS (SMI-5178)', () => {
  it('deep-equals the 7-entry canonical contract from packages/core/src/compatibility/slugs.ts', () => {
    expect(COMPAT_LABELS).toEqual(EXPECTED)
  })
})

/**
 * SMI-6503 parity guard: HARNESS_HEADING_LABELS must cover every ClientId that
 * core recognises.
 *
 * Source of truth: packages/core/src/install/paths.ts (the `ClientId` union).
 * The website client bundle CANNOT import @skillsmith/core at runtime, so the
 * key set is duplicated here and this test is the enforcement boundary.
 *
 * Pattern: follows skill-card.parity.test.ts (SMI-5178 / SMI-5366), which does
 * the same for COMPAT_LABELS against core's COMPATIBILITY_LABELS.
 *
 * Note this guards KEYS ONLY, deliberately. The values are not shared with
 * core's CLIENT_DISPLAY_LABELS and must not be: that map feeds mid-sentence
 * install guidance (`Start a new ${label} session…` in cli's install-skill.ts),
 * where `agents` reads "your agent". As a standalone section heading the same
 * string reads wrong, so this page carries its own wording. What the two maps
 * owe each other is coverage, not phrasing.
 *
 * When a client is added to core's ClientId union, add it to
 * HARNESS_HEADING_LABELS and to EXPECTED_CLIENT_IDS below in lockstep.
 */

import { describe, it, expect } from 'vitest'
import { HARNESS_HEADING_LABELS, harnessHeadingLabel } from './skills-page-render'

// Hardcoded canonical contract — transcribed from the ClientId union in
// packages/core/src/install/paths.ts. Do NOT derive this from
// HARNESS_HEADING_LABELS itself; that would make the test circular.
const EXPECTED_CLIENT_IDS = [
  'claude-code',
  'cursor',
  'copilot',
  'windsurf',
  'agents',
  'opencode',
  'hermes',
  'grok',
  'antigravity',
] as const

describe('HARNESS_HEADING_LABELS — parity with core ClientId (SMI-6503)', () => {
  it('has a heading label for every client core recognises', () => {
    const missing = EXPECTED_CLIENT_IDS.filter((id) => !(id in HARNESS_HEADING_LABELS))
    expect(missing).toEqual([])
  })

  it('does not carry labels for clients core does not recognise', () => {
    // A stale key is the quieter half of drift: it survives a client being
    // removed from core and keeps rendering a label for something unsupported.
    const extra = Object.keys(HARNESS_HEADING_LABELS).filter(
      (k) => !(EXPECTED_CLIENT_IDS as readonly string[]).includes(k)
    )
    expect(extra).toEqual([])
  })

  it('never returns an empty heading for a recognised client', () => {
    for (const id of EXPECTED_CLIENT_IDS) {
      expect(harnessHeadingLabel(id).trim()).not.toBe('')
    }
  })

  it('does not leak a raw slug for any recognised client', () => {
    // The raw-slug fallback exists for genuinely unknown harnesses. If it fires
    // for a client core supports, the label is missing and the heading is
    // degraded — which is exactly what this guard is for.
    for (const id of EXPECTED_CLIENT_IDS) {
      expect(harnessHeadingLabel(id)).not.toBe(id)
    }
  })
})

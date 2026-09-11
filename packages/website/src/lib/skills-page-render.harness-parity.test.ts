/**
 * SMI-6503 parity guard: HARNESS_HEADING_LABELS must cover every ClientId that
 * core recognises.
 *
 * Source of truth: packages/core/src/install/paths.ts (`CLIENT_IDS`), imported
 * DIRECTLY below.
 *
 * The website client BUNDLE cannot import @skillsmith/core at runtime, which is
 * why HARNESS_HEADING_LABELS is page-local. This test is not the bundle: it runs
 * in Node under vitest, so it can reach core's source and compare against the
 * real thing.
 *
 * That matters. An earlier revision transcribed the id list into a local
 * constant, following skill-card.parity.test.ts's precedent — but a hardcoded
 * copy in the same package only proves map-versus-copy agreement. Adding a
 * client to core would change neither side and this test would stay green,
 * which is the drift it exists to catch. The precedent has the same weakness;
 * this does not follow it there.
 *
 * Note this guards KEYS ONLY, deliberately. The values are not shared with
 * core's CLIENT_DISPLAY_LABELS and must not be: that map feeds mid-sentence
 * install guidance (`Start a new ${label} session…` in cli's install-skill.ts),
 * where `agents` reads "your agent". As a standalone section heading the same
 * string reads wrong, so this page carries its own wording. What the two maps
 * owe each other is coverage, not phrasing.
 *
 * Adding a client to core's CLIENT_IDS now turns this red on its own — no
 * second list to remember to update.
 */

import { describe, it, expect } from 'vitest'
import { HARNESS_HEADING_LABELS, harnessHeadingLabel } from './skills-page-render'
// Test-only source import. Node-side only — never reaches the client bundle.
import { CLIENT_IDS } from '../../../core/src/install/paths'

const EXPECTED_CLIENT_IDS = CLIENT_IDS

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

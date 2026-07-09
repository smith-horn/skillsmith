/**
 * Tests for the SMI-5595 additions to inventory-view.ts: SKILL_STATE_META's
 * `suggestedAction` field and the device-wide `computeDeviceBatchTip` helper.
 *
 * Split out of inventory-view.test.ts to keep both files under the
 * project's 500-line-per-file standard.
 */

import { describe, expect, it } from 'vitest'
import {
  computeDeviceBatchTip,
  DEVICE_BATCH_UPDATE_TIP,
  SKILL_STATE_META,
  type SkillState,
  type SkillView,
} from './inventory-view'

/**
 * Build a complete SkillView with sensible defaults. Override only the
 * fields each test cares about.
 */
function makeSkillView(partial: Partial<SkillView>): SkillView {
  return {
    harness: 'claude-code',
    skillId: 'skill-default',
    version: '1.0.0',
    present: true,
    pinned: false,
    state: 'current',
    author: null,
    repository: null,
    license: null,
    ...partial,
  }
}

describe('SKILL_STATE_META — suggestedAction (SMI-5595)', () => {
  const allStates: SkillState[] = [
    'current',
    'drifted',
    'missing',
    'pinned',
    'unknown',
    'local',
    'source-identified',
    'pending',
  ]

  it('every entry has a suggestedAction field of the correct type', () => {
    for (const state of allStates) {
      const meta = SKILL_STATE_META[state]
      expect(meta).toHaveProperty('suggestedAction')
      expect(meta.suggestedAction === null || typeof meta.suggestedAction === 'string').toBe(true)
    }
  })

  it('suggestedAction copy matches the exact reviewed spec strings', () => {
    expect(SKILL_STATE_META.current.suggestedAction).toBe('No action needed.')
    expect(SKILL_STATE_META.drifted.suggestedAction).toBe(
      'Run `skillsmith update <skill>` on that machine.'
    )
    expect(SKILL_STATE_META.missing.suggestedAction).toBe(
      'Confirm the skill is still installed, then re-run `skillsmith inventory push` from that machine — or reinstall it if it was removed intentionally.'
    )
    expect(SKILL_STATE_META.pinned.suggestedAction).toBe(
      'No action needed. Run `skillsmith unpin <skill>` if you want drift checks again.'
    )
    expect(SKILL_STATE_META.unknown.suggestedAction).toBe(
      'No action needed — expected for skills you wrote yourself or installed outside the registry.'
    )
    expect(SKILL_STATE_META.local.suggestedAction).toBe(
      "No action needed. Add `author`, `repository`, and `license` front-matter to the skill's `SKILL.md` if you'd like it to show as Claimed source instead."
    )
    expect(SKILL_STATE_META['source-identified'].suggestedAction).toBe(
      "No action needed — the author/repository shown is self-reported and hasn't been verified by the registry. It would show as a verified source if the skill is published to the registry (`skillsmith publish`)."
    )
    expect(SKILL_STATE_META.pending.suggestedAction).toBe(
      'None — this is a transient state. Refresh the page in a few seconds.'
    )
  })

  it('drifted and pinned suggestedAction contain the <skill> placeholder inside a backtick span', () => {
    expect(SKILL_STATE_META.drifted.suggestedAction).toContain('`skillsmith update <skill>`')
    expect(SKILL_STATE_META.pinned.suggestedAction).toContain('`skillsmith unpin <skill>`')
  })

  it('current and unknown suggestedAction contain no backticks or <skill> placeholder', () => {
    expect(SKILL_STATE_META.current.suggestedAction).not.toContain('`')
    expect(SKILL_STATE_META.current.suggestedAction).not.toContain('<skill>')
    expect(SKILL_STATE_META.unknown.suggestedAction).not.toContain('`')
    expect(SKILL_STATE_META.unknown.suggestedAction).not.toContain('<skill>')
  })

  it('no state other than drifted/pinned contains the <skill> placeholder', () => {
    for (const state of allStates) {
      if (state === 'drifted' || state === 'pinned') continue
      expect(SKILL_STATE_META[state].suggestedAction).not.toContain('<skill>')
    }
  })
})

describe('computeDeviceBatchTip', () => {
  it('returns null for an empty skills array', () => {
    expect(computeDeviceBatchTip([])).toBeNull()
  })

  it('returns null for 0 drifted skills', () => {
    const skills = [
      makeSkillView({ skillId: 'a', state: 'current' }),
      makeSkillView({ skillId: 'b', state: 'missing' }),
    ]
    expect(computeDeviceBatchTip(skills)).toBeNull()
  })

  it('returns null for exactly 1 drifted skill', () => {
    const skills = [
      makeSkillView({ skillId: 'a', state: 'drifted' }),
      makeSkillView({ skillId: 'b', state: 'current' }),
    ]
    expect(computeDeviceBatchTip(skills)).toBeNull()
  })

  it('returns the tip string for exactly 2 drifted skills', () => {
    const skills = [
      makeSkillView({ skillId: 'a', state: 'drifted' }),
      makeSkillView({ skillId: 'b', state: 'drifted' }),
    ]
    expect(computeDeviceBatchTip(skills)).toBe(DEVICE_BATCH_UPDATE_TIP)
  })

  it('returns the tip string for 3+ drifted skills', () => {
    const skills = [
      makeSkillView({ skillId: 'a', state: 'drifted' }),
      makeSkillView({ skillId: 'b', state: 'drifted' }),
      makeSkillView({ skillId: 'c', state: 'drifted' }),
    ]
    expect(computeDeviceBatchTip(skills)).toBe(DEVICE_BATCH_UPDATE_TIP)
  })

  it('fires when the 2 drifted skills are on two DIFFERENT harnesses (device-wide, not per-harness)', () => {
    const skills = [
      makeSkillView({ skillId: 'a', harness: 'claude-code', state: 'drifted' }),
      makeSkillView({ skillId: 'b', harness: 'cursor', state: 'drifted' }),
    ]
    expect(computeDeviceBatchTip(skills)).toBe(DEVICE_BATCH_UPDATE_TIP)
  })

  it('pinned skills never count toward the drifted threshold, regardless of count', () => {
    const skills = [
      makeSkillView({ skillId: 'a', state: 'pinned' }),
      makeSkillView({ skillId: 'b', state: 'pinned' }),
      makeSkillView({ skillId: 'c', state: 'pinned' }),
    ]
    expect(computeDeviceBatchTip(skills)).toBeNull()
  })
})

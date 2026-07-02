/**
 * @fileoverview Tests for the paywall trigger-state store (SMI-5456 Wave 1
 *               Step 5, QD-3). Covers the P-5 "Trigger state" invariant:
 *               "One prompt per session enforced from persisted state, not
 *               memory" (cap) + "30-day mute expiry" test.
 * @module @skillsmith/core/paywall-triggers/store.test
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  canShowTrigger,
  getNudgeCooldownState,
  isTriggerMuted,
  loadTriggerState,
  recordImpression,
  recordTriggerDismissal,
  TRIGGER_DISMISSAL_THRESHOLD,
  TRIGGER_MUTE_DAYS,
  TRIGGER_STATE_DIR_ENV_VAR,
} from './index.js'

let stateDir: string
let prevEnv: string | undefined
let prevNudgeEnv: string | undefined

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'skillsmith-paywall-triggers-'))
  prevEnv = process.env[TRIGGER_STATE_DIR_ENV_VAR]
  process.env[TRIGGER_STATE_DIR_ENV_VAR] = stateDir
  prevNudgeEnv = process.env.SKILLSMITH_AGENT_NUDGE_STATE
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  if (prevEnv !== undefined) process.env[TRIGGER_STATE_DIR_ENV_VAR] = prevEnv
  else delete process.env[TRIGGER_STATE_DIR_ENV_VAR]
  if (prevNudgeEnv !== undefined) process.env.SKILLSMITH_AGENT_NUDGE_STATE = prevNudgeEnv
  else delete process.env.SKILLSMITH_AGENT_NUDGE_STATE
})

describe('session cap (persisted, not memory)', () => {
  it('allows showing a trigger the first time in a session', () => {
    expect(canShowTrigger('T1', 'session-a')).toBe(true)
  })

  it('blocks a second impression of the same trigger in the same session', () => {
    recordImpression('T1', 'session-a')
    expect(canShowTrigger('T1', 'session-a')).toBe(false)
  })

  it('the cap is read from persisted state, not in-memory — a fresh loadTriggerState call after recordImpression reflects it', () => {
    recordImpression('T2', 'session-x')
    const state = loadTriggerState('T2')
    expect(state.lastSessionShown).toBe('session-x')
  })

  it('allows the SAME trigger again in a DIFFERENT session (documented: concurrent sessions may each prompt once)', () => {
    recordImpression('T1', 'session-a')
    expect(canShowTrigger('T1', 'session-b')).toBe(true)
  })

  it('caps are independent per trigger id', () => {
    recordImpression('T1', 'session-a')
    expect(canShowTrigger('T3', 'session-a')).toBe(true)
  })
})

describe('30-day mute expiry', () => {
  it('does not mute after one dismissal', () => {
    const state = recordTriggerDismissal('T4')
    expect(state.dismissalCount).toBe(1)
    expect(isTriggerMuted(state)).toBe(false)
  })

  it(`mutes after ${TRIGGER_DISMISSAL_THRESHOLD} dismissals`, () => {
    recordTriggerDismissal('T4')
    const state = recordTriggerDismissal('T4')
    expect(state.dismissalCount).toBe(TRIGGER_DISMISSAL_THRESHOLD)
    expect(isTriggerMuted(state)).toBe(true)
  })

  it('a muted trigger cannot be shown, even in a session it was never shown in', () => {
    recordTriggerDismissal('T1')
    recordTriggerDismissal('T1')
    expect(canShowTrigger('T1', 'brand-new-session')).toBe(false)
  })

  it(`is still muted 1ms before ${TRIGGER_MUTE_DAYS} days elapse`, () => {
    const now = 1_000_000
    recordTriggerDismissal('T2', now)
    recordTriggerDismissal('T2', now)
    const almostExpired = now + TRIGGER_MUTE_DAYS * 24 * 60 * 60 * 1000 - 1
    const state = loadTriggerState('T2')
    expect(isTriggerMuted(state, almostExpired)).toBe(true)
  })

  it(`the mute has expired exactly at ${TRIGGER_MUTE_DAYS} days`, () => {
    const now = 1_000_000
    recordTriggerDismissal('T2', now)
    recordTriggerDismissal('T2', now)
    const exactlyExpired = now + TRIGGER_MUTE_DAYS * 24 * 60 * 60 * 1000
    const state = loadTriggerState('T2')
    expect(isTriggerMuted(state, exactlyExpired)).toBe(false)
  })

  it('canShowTrigger allows the trigger again once the mute has expired', () => {
    const now = 1_000_000
    recordTriggerDismissal('T3', now)
    recordTriggerDismissal('T3', now)
    const afterMute = now + TRIGGER_MUTE_DAYS * 24 * 60 * 60 * 1000 + 1
    expect(canShowTrigger('T3', 'any-session', afterMute)).toBe(true)
  })

  it('dismissal count keeps accumulating past the threshold (never resets)', () => {
    recordTriggerDismissal('T1')
    recordTriggerDismissal('T1')
    const state = recordTriggerDismissal('T1')
    expect(state.dismissalCount).toBe(3)
  })
})

describe('getNudgeCooldownState — format compatibility with the SessionStart hook', () => {
  it('returns null when the nudge-state file does not exist', () => {
    const nudgeFile = join(stateDir, 'agent-nudge.state')
    process.env.SKILLSMITH_AGENT_NUDGE_STATE = nudgeFile
    expect(getNudgeCooldownState()).toBeNull()
  })

  it('reads a plain epoch-seconds integer written by the hook (no JSON, no wrapper)', () => {
    const nudgeFile = join(stateDir, 'agent-nudge.state')
    process.env.SKILLSMITH_AGENT_NUDGE_STATE = nudgeFile
    writeFileSync(nudgeFile, '1735689600')
    expect(getNudgeCooldownState()).toBe(1735689600)
  })

  it('treats malformed content as "no prior nudge" (matches the hook\'s own tolerant parsing)', () => {
    const nudgeFile = join(stateDir, 'agent-nudge.state')
    process.env.SKILLSMITH_AGENT_NUDGE_STATE = nudgeFile
    writeFileSync(nudgeFile, 'not-a-number')
    expect(getNudgeCooldownState()).toBeNull()
  })
})

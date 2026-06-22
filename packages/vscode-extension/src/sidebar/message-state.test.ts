/**
 * Tests for the single-owner sidebar message state machine (SMI-5345 / #1438).
 *
 * Asserts the precedence matrix (offline > banner > hint > undefined) and the
 * race-resolving invariants: a banner set while offline stays masked by the
 * offline copy; clearing offline restores whichever lower-precedence input is
 * still set; and a reconnect arriving after a search shows the banner, not
 * `undefined` (the old multi-writer clobber).
 *
 * The TreeView is mocked as a plain `{ message: undefined }` object cast to the
 * type; assertions read `.message` directly.
 */
import { describe, it, expect } from 'vitest'
import type * as vscode from 'vscode'
import {
  createSidebarMessageState,
  OFFLINE_MESSAGE,
  type SidebarMessageState,
} from './message-state.js'

/** A minimal TreeView stand-in — only `.message` is exercised. */
function makeTreeView(): { view: vscode.TreeView<unknown>; raw: { message: string | undefined } } {
  const raw: { message: string | undefined } = { message: undefined }
  return { view: raw as unknown as vscode.TreeView<unknown>, raw }
}

function setup(): { state: SidebarMessageState; raw: { message: string | undefined } } {
  const { view, raw } = makeTreeView()
  return { state: createSidebarMessageState(view), raw }
}

describe('createSidebarMessageState — precedence matrix', () => {
  it('starts with no message', () => {
    const { raw } = setup()
    expect(raw.message).toBeUndefined()
  })

  it('shows the first-run hint when only the hint is set', () => {
    const { state, raw } = setup()
    state.setFirstRunHint('hint')
    expect(raw.message).toBe('hint')
  })

  it('search banner outranks the first-run hint', () => {
    const { state, raw } = setup()
    state.setFirstRunHint('hint')
    state.setSearchBanner('banner')
    expect(raw.message).toBe('banner')
  })

  it('offline copy outranks the search banner', () => {
    const { state, raw } = setup()
    state.setSearchBanner('banner')
    state.setOffline(true)
    expect(raw.message).toBe(OFFLINE_MESSAGE)
  })

  it('offline copy outranks the first-run hint', () => {
    const { state, raw } = setup()
    state.setFirstRunHint('hint')
    state.setOffline(true)
    expect(raw.message).toBe(OFFLINE_MESSAGE)
  })
})

describe('createSidebarMessageState — clearing', () => {
  it('clearing the banner falls back to the first-run hint', () => {
    const { state, raw } = setup()
    state.setFirstRunHint('hint')
    state.setSearchBanner('banner')
    state.setSearchBanner(undefined)
    expect(raw.message).toBe('hint')
  })

  it('clearing the banner with no hint falls back to undefined', () => {
    const { state, raw } = setup()
    state.setSearchBanner('banner')
    state.setSearchBanner(undefined)
    expect(raw.message).toBeUndefined()
  })

  it('clearing the hint with no banner falls back to undefined', () => {
    const { state, raw } = setup()
    state.setFirstRunHint('hint')
    state.setFirstRunHint(undefined)
    expect(raw.message).toBeUndefined()
  })
})

describe('createSidebarMessageState — offline/banner race invariants', () => {
  it('a banner set WHILE offline stays masked by the offline copy', () => {
    const { state, raw } = setup()
    state.setOffline(true)
    state.setSearchBanner('banner')
    expect(raw.message).toBe(OFFLINE_MESSAGE)
  })

  it('clearing offline restores the banner that was set while offline', () => {
    const { state, raw } = setup()
    state.setOffline(true)
    state.setSearchBanner('banner')
    state.setOffline(false)
    expect(raw.message).toBe('banner')
  })

  it('clearing offline restores the hint when no banner is set', () => {
    const { state, raw } = setup()
    state.setFirstRunHint('hint')
    state.setOffline(true)
    state.setOffline(false)
    expect(raw.message).toBe('hint')
  })

  it('reconnect AFTER a search shows the banner, not undefined (no clobber)', () => {
    const { state, raw } = setup()
    // A search lands a banner...
    state.setSearchBanner('Showing results for "foo"')
    // ...then the client drops and reconnects mid-session.
    state.setOffline(true)
    state.setOffline(false)
    // The banner must survive — the old multi-writer bug erased it.
    expect(raw.message).toBe('Showing results for "foo"')
  })
})

/**
 * Single-owner state machine for `TreeView.message` (SMI-5345 / #1438).
 *
 * Before this, three sites wrote `skillsView.message` directly — the first-run
 * hint (extension.ts), the search/no-results/offline banners (searchSkills.ts),
 * and (newly) the proactive MCP-offline copy. Concurrent writers raced: a
 * reconnect firing mid-search could clobber a banner, and an out-of-band drop
 * could erase the first-run hint. This module is the ONLY writer of
 * `treeView.message`. Each input is held in closure state; every setter
 * recomputes the message by a fixed precedence so the surface can never drift:
 *
 *   offline-copy (if offline) > searchBanner (if set) > firstRunHint (if set) > undefined
 */
import type * as vscode from 'vscode'

/** The proactive MCP-offline sidebar copy (SMI-5345). */
export const OFFLINE_MESSAGE =
  'Skillsmith server unavailable — start the MCP server, then Reconnect from the status bar.'

/**
 * The single writer of `TreeView.message`. Each setter mutates one closure
 * input and re-derives the visible message by precedence.
 */
export interface SidebarMessageState {
  /** The persistent first-run / pre-search hint (lowest precedence). */
  setFirstRunHint(text: string | undefined): void
  /** The active search / no-results context banner (middle precedence). */
  setSearchBanner(text: string | undefined): void
  /** Whether the MCP server is offline (highest precedence when true). */
  setOffline(isOffline: boolean): void
}

/**
 * Creates the single-owner message state machine bound to a TreeView. Holds the
 * first-run hint, search banner, and offline flag in closure state; recomputes
 * `treeView.message` on every setter.
 */
export function createSidebarMessageState(treeView: vscode.TreeView<unknown>): SidebarMessageState {
  let firstRunHint: string | undefined
  let searchBanner: string | undefined
  let isOffline = false

  function resolve(): string | undefined {
    if (isOffline) {
      return OFFLINE_MESSAGE
    }
    if (searchBanner !== undefined) {
      return searchBanner
    }
    if (firstRunHint !== undefined) {
      return firstRunHint
    }
    return undefined
  }

  function recompute(): void {
    const next = resolve()
    // `TreeView.message` is `message?: string`; under exactOptionalPropertyTypes
    // a direct `= undefined` is rejected. Set the string when present, otherwise
    // `delete` to clear the banner (the documented way to remove the message).
    if (next === undefined) {
      delete treeView.message
    } else {
      treeView.message = next
    }
  }

  return {
    setFirstRunHint(text: string | undefined): void {
      firstRunHint = text
      recompute()
    },
    setSearchBanner(text: string | undefined): void {
      searchBanner = text
      recompute()
    },
    setOffline(offline: boolean): void {
      isOffline = offline
      recompute()
    },
  }
}

/**
 * SMI-6531 (A1 step 6c-ii-b): fixtures for `assignLocks` and for wave 2's
 * M-ORD (UD60 bytewise order of the lock path), built as real directories.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BackupsListing } from '../../../src/services/skill-backups.listing.types.js'

export const FF5A = 'ｚ'
export const EMOJI = '\u{1F600}'

/**
 * Two skills roots whose lock paths differ at U+FF5A vs U+1F600. Bytewise (UTF-8)
 * the U+FF5A root sorts first; the default `sort()` and `localeCompare` put the
 * U+1F600 root first (UTF-16 surrogate 0xD83D < 0xFF5A). Returned in the order
 * that default sort gives, which is the WRONG order, so a reader that does not
 * order bytewise is caught.
 */
export function orderingRoots(base: string): { ff5a: string; emoji: string } {
  const ff5a = path.join(base, `r${FF5A}`)
  const emoji = path.join(base, `r${EMOJI}`)
  fs.mkdirSync(ff5a, { recursive: true })
  fs.mkdirSync(emoji, { recursive: true })
  return { ff5a: fs.realpathSync(ff5a), emoji: fs.realpathSync(emoji) }
}

export interface ParkedFx {
  copyPath: string
  kind: string | null
  /** The discovered root's path, or null for an index-only area. */
  skillsRoot: string | null
  areaDir: string
}
export interface BackupFx {
  copyPath: string
  skillsDir: string | null
  /** The `<dirName>` area directory. */
  areaPath: string
}
export interface IndexFx {
  copyPath: string
  kind: string | null
  stateRoot: string
}

/** A listing holding only what `assignLocks` reads. */
export function listingOf(a: {
  stateRoot: string
  parked?: ParkedFx[]
  backups?: BackupFx[]
  index?: IndexFx[]
}): BackupsListing {
  const parked = (a.parked ?? []).map((p) => ({
    ref: { areaDir: p.areaDir, skillsRoot: p.skillsRoot },
    rows: [{ copy: { copyPath: p.copyPath }, kind: p.kind }],
  }))
  const backups = [
    {
      stateRoot: a.stateRoot,
      areas: (a.backups ?? []).map((b) => ({
        areaPath: b.areaPath,
        rows: [{ copy: { copyPath: b.copyPath }, skillsDir: b.skillsDir }],
      })),
    },
  ]
  const lines = (a.index ?? []).map((i) => ({
    copyPath: i.copyPath,
    stateRoot: i.stateRoot,
    entry: { kind: i.kind },
  }))
  return {
    discovery: { stateRoots: [a.stateRoot], roots: [], skipped: [] },
    parked,
    backups,
    index: { facts: { lines }, stale: [] },
  } as unknown as BackupsListing
}

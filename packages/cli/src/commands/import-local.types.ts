/**
 * @fileoverview Types for `skillsmith import-local` (SMI-4665)
 */
import type { ClientId } from '@skillsmith/core/install'

export interface ImportLocalOptions {
  /** Optional positional path. Defaults to the canonical install path. */
  path?: string
  /** Walk a different client's install directory (`cursor`, `copilot`, etc). */
  client?: ClientId
  /** Watch the target directory for changes and re-import on change. */
  watch?: boolean
  /** Print what would be imported without writing to the DB. */
  dryRun?: boolean
  /** Emit a single machine-readable summary object on stdout. */
  json?: boolean
  /** Database file path override (test injection). */
  dbPath?: string
}

/**
 * Per-skill record extracted from a `SKILL.md` on disk.
 */
export interface LocalSkillRecord {
  /** Deterministic id: sha256(canonicalPath).slice(0, 32). */
  id: string
  /** Canonical absolute path to the SKILL.md. */
  path: string
  /** Name from frontmatter (or fallback to parent dir basename). */
  name: string
  /** Description from frontmatter (or first non-heading paragraph). */
  description: string | null
  /** Trigger phrases from frontmatter (`triggers:` array). */
  triggers: string[]
  /** Tags from frontmatter (`tags:` array). */
  tags: string[]
  /** Set when frontmatter parsing failed. The walker still yields the record
   *  so the action handler can surface the error in the summary. */
  error?: string
}

/**
 * End-of-run summary. Stable shape — `--json` emits exactly this.
 */
export interface ImportLocalResult {
  rootDir: string
  scanned: number
  imported: number
  updated: number
  unchanged: number
  errors: Array<{ path: string; message: string }>
  skipped: Array<{ path: string; reason: string }>
  durationMs: number
  dryRun: boolean
}

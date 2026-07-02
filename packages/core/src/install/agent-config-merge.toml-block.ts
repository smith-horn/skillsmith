/**
 * Marker-delimited TOML block merge for Codex (SMI-5456 Wave 1 Step 5).
 *
 * Codex's config lives entirely in `~/.codex/config.toml` — MCP server
 * registration (`[mcp_servers.skillsmith]`), the named-agent shim
 * (`[agents.skillsmith-agent]`, already rendered as TOML text by
 * `renderCodexToml` in the — locked for this step — agent-pack generator),
 * and hook wiring all share this one file. The repo has no confirmed real
 * TOML dependency (`smol-toml` appears only under root `overrides`, pinning
 * a transitive tool dependency, not a direct `dependencies`/`devDependencies`
 * entry of `@skillsmith/core` or `@skillsmith/cli`) — adding one is a
 * lockfile-risk change out of scope for this step. Per the task brief's
 * explicit fallback for "no [format] dep": generate the block textually with
 * a clearly-delimited managed section, exactly mirroring how
 * `renderCodexToml` (shims.ts, locked) already emits raw TOML text via
 * `JSON.stringify`-quoted strings rather than a library. This keeps every
 * OTHER line of the user's `config.toml` — their own tables, comments,
 * formatting — completely untouched; only the text between our markers is
 * ever rewritten.
 *
 * Ownership model: text between `# >>> skillsmith:<markerId> >>>` and
 * `# <<< skillsmith:<markerId> <<<` is unambiguously ours (idempotent
 * update-in-place). A bare occurrence of the target table header OUTSIDE any
 * marker block (`foreignHeaderPattern`) is a hand-written foreign entry —
 * `force` does NOT override this case: appending a second `[table]` header
 * with the same name risks producing invalid/ambiguous TOML without a real
 * parser to detect and merge it, so this always returns `'conflict'` for a
 * genuinely foreign, non-delimited entry regardless of `force`.
 *
 * @module @skillsmith/core/install/agent-config-merge.toml-block
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { markBackedUp, shouldBackup, type MergeResult } from './agent-config-merge.types.js'

export interface TomlBlockMergeOptions {
  path: string
  /** Stable id for the marker comment, e.g. `'mcp_servers.skillsmith'`. */
  markerId: string
  /** Raw TOML text to install between the markers (no marker lines, no leading/trailing blank lines required). */
  blockContent: string
  /** Matches a bare (non-delimited) occurrence of the same table header, e.g. `/^\[mcp_servers\.skillsmith\]/m`. */
  foreignHeaderPattern: RegExp
  backupDir: string
  force?: boolean
  /** See `MergeOptions.alreadyBackedUpPaths` — Codex merges TWO blocks (MCP + agents shim) into the same `config.toml` per install run. */
  alreadyBackedUpPaths?: Set<string>
}

function markerStart(markerId: string): string {
  return `# >>> skillsmith:${markerId} >>>`
}
function markerEnd(markerId: string): string {
  return `# <<< skillsmith:${markerId} <<<`
}

function writeBackup(sourcePath: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = sourcePath.split('/').pop() ?? 'config'
  const backupPath = join(backupDir, `${stamp}-${baseName}.bak`)
  writeFileSync(backupPath, readFileSync(sourcePath, 'utf-8'), { mode: 0o600 })
  return backupPath
}

/** Merge a marker-delimited TOML block into `opts.path`. See module header for the full ownership contract. */
export function mergeTomlBlock(opts: TomlBlockMergeOptions): MergeResult {
  const {
    path,
    markerId,
    blockContent,
    foreignHeaderPattern,
    backupDir,
    force = false,
    alreadyBackedUpPaths,
  } = opts
  const start = markerStart(markerId)
  const end = markerEnd(markerId)
  const trimmedBlock = blockContent.trim()

  const existed = existsSync(path)
  let raw = ''
  if (existed) {
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (e) {
      return { status: 'error', path, backupPath: null, errorMessage: (e as Error).message }
    }
  }

  const blockRegex = new RegExp(`${escapeRegExp(start)}\\n([\\s\\S]*?)\\n${escapeRegExp(end)}`)
  const match = raw.match(blockRegex)

  if (match) {
    const existingBlock = (match[1] ?? '').trim()
    if (existingBlock === trimmedBlock) {
      return { status: 'unchanged', path, backupPath: null }
    }
    const backupPath = shouldBackup(path, alreadyBackedUpPaths)
      ? writeBackup(path, backupDir)
      : null
    markBackedUp(path, alreadyBackedUpPaths)
    const replacement = `${start}\n${trimmedBlock}\n${end}`
    const updated = raw.replace(blockRegex, replacement)
    writeFileSync(path, updated, { mode: 0o600 })
    return { status: 'updated', path, backupPath }
  }

  // No marker block found. A bare same-name table header outside any marker
  // is a foreign hand-written entry — never safely mergeable without a real
  // TOML parser (see module header). `force` does not override this case.
  if (foreignHeaderPattern.test(raw)) {
    void force
    return { status: 'conflict', path, backupPath: null }
  }

  const backupPath =
    existed && shouldBackup(path, alreadyBackedUpPaths) ? writeBackup(path, backupDir) : null
  markBackedUp(path, alreadyBackedUpPaths)
  const separator =
    raw.length > 0 && !raw.endsWith('\n\n') ? (raw.endsWith('\n') ? '\n' : '\n\n') : ''
  const appended = `${raw}${separator}${start}\n${trimmedBlock}\n${end}\n`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, appended, { mode: 0o600 })
  // Always 'created', never `existed ? 'updated' : 'created'`: OUR block
  // didn't exist before this write regardless of whether the surrounding
  // FILE pre-existed (a foreign file with unrelated content, or — within
  // one install run — a file another block already created moments ago,
  // e.g. Codex's agents-shim block creating config.toml before the
  // mcp_servers block merges into it). 'updated' is reserved for replacing
  // OUR OWN previously-installed block with different content (the `match`
  // branch above).
  return { status: 'created', path, backupPath }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

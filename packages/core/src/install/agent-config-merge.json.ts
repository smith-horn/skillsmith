/**
 * JSON config-merge helper for `sklx agent install` (SMI-5456 Wave 1 Step 5).
 *
 * Targets the `mcpServers`/`mcp`-shaped config files four of the seven
 * harnesses use (claude-code, cursor, copilot, windsurf; also opencode's
 * best-effort `mcp` key — see `agent-harness-targets.ts`). Backup-first,
 * idempotent, preserve-and-prompt semantics per the plan's P-5 "Harness MCP
 * config files" invariant: "Installer merges keys it owns, never whole-file
 * writes; detects foreign `skillsmith` entries and prompts."
 *
 * Survey of existing config-write patterns (plan-mandated, "convention check
 * before novelty"): `grep -rn "mcp.json\|mcp_config\|claude.json"
 * packages/cli/src/ packages/core/src/` turned up
 * `mcp-server.template.snippets.ts` (SMI-4580, docs-only — renders snippet
 * TEXT for a human to paste, never writes a file) and
 * `skill-installation.policy.ts` (classifies `.mcp.json` as a scan target,
 * never writes one). Neither is a merge-writer to follow structurally, so
 * this module's shape instead mirrors the nearest write-path precedent in
 * the codebase: `config/index.ts`'s `saveConfig()` (mkdir 0700 + writeFile
 * 0600, read-merge-write, JSON.stringify(..., null, 2)).
 *
 * @module @skillsmith/core/install/agent-config-merge.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  deepEqualJson,
  looksLikeOurMcpEntry,
  markBackedUp,
  shouldBackup,
  type MergeOptions,
  type MergeResult,
} from './agent-config-merge.types.js'

/** Read + set a nested key path on a JSON object, creating intermediate objects. */
function getAtPath(root: Record<string, unknown>, keyPath: readonly string[]): unknown {
  let cur: unknown = root
  for (const key of keyPath) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function setAtPath(
  root: Record<string, unknown>,
  keyPath: readonly string[],
  value: unknown
): void {
  let cur: Record<string, unknown> = root
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i]!
    const next = cur[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {}
    }
    cur = cur[key] as Record<string, unknown>
  }
  const lastKey = keyPath[keyPath.length - 1]
  if (lastKey !== undefined) cur[lastKey] = value
}

function writeBackup(sourcePath: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = sourcePath.split('/').pop() ?? 'config'
  const backupPath = join(backupDir, `${stamp}-${baseName}.bak`)
  writeFileSync(backupPath, readFileSync(sourcePath, 'utf-8'), { mode: 0o600 })
  return backupPath
}

/**
 * Merge a `skillsmith` MCP server entry into a JSON config file at
 * `opts.path`, under `opts.keyPath` (e.g. `['mcpServers']`).
 *
 * Never performs a whole-file write of unrelated keys — the file is parsed,
 * exactly one nested key (`skillsmith`) is set at `[...keyPath, 'skillsmith']`,
 * and the WHOLE document (all other keys untouched) is re-serialized. A
 * missing file is treated as `{}` (created fresh).
 */
export function mergeJsonMcpEntry(
  opts: MergeOptions & { keyPath: readonly string[] }
): MergeResult {
  const { path, keyPath, entryValue, backupDir, force = false, alreadyBackedUpPaths } = opts

  let doc: Record<string, unknown> = {}
  let existed = false
  if (existsSync(path)) {
    existed = true
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (e) {
      return { status: 'error', path, backupPath: null, errorMessage: (e as Error).message }
    }
    try {
      const parsed: unknown = raw.trim().length === 0 ? {} : JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'error', path, backupPath: null, errorMessage: 'not a JSON object' }
      }
      doc = parsed as Record<string, unknown>
    } catch (e) {
      return { status: 'error', path, backupPath: null, errorMessage: (e as Error).message }
    }
  }

  const container = getAtPath(doc, keyPath)
  const existingEntry =
    container && typeof container === 'object' && !Array.isArray(container)
      ? (container as Record<string, unknown>).skillsmith
      : undefined

  if (existingEntry !== undefined) {
    if (deepEqualJson(existingEntry, entryValue)) {
      return { status: 'unchanged', path, backupPath: null }
    }
    if (!looksLikeOurMcpEntry(existingEntry) && !force) {
      // Non-interactive refusal (P-5 preserve-existing): never clobber a
      // foreign entry silently, never block on a prompt in a scripted
      // install — surface a 'conflict' the CLI report + --force flag address.
      return { status: 'conflict', path, backupPath: null }
    }
    // Recognizable as ours (or force=true): back up (once per install run),
    // then overwrite. Marking `alreadyBackedUpPaths` UNCONDITIONALLY (not
    // only when a backup was actually written) is what prevents a LATER
    // merge into this same path this run from treating content THIS merge
    // just wrote as pre-install state needing its own backup — see
    // `agent-pack-installer.test.ts` "double-install idempotency" /
    // "preserve-existing" suites.
    const backupPath =
      existed && shouldBackup(path, alreadyBackedUpPaths) ? writeBackup(path, backupDir) : null
    markBackedUp(path, alreadyBackedUpPaths)
    setAtPath(doc, keyPath, { ...(container as Record<string, unknown>), skillsmith: entryValue })
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    return { status: 'updated', path, backupPath }
  }

  // No existing entry — safe create. Still back up the FILE (not the
  // skillsmith key, which didn't exist) so a foreign file with unrelated
  // content the user cares about is always one restore away — unless an
  // earlier merge THIS RUN already captured the pre-install state.
  const backupPath =
    existed && shouldBackup(path, alreadyBackedUpPaths) ? writeBackup(path, backupDir) : null
  markBackedUp(path, alreadyBackedUpPaths)
  const currentContainer =
    container && typeof container === 'object' && !Array.isArray(container)
      ? (container as Record<string, unknown>)
      : {}
  setAtPath(doc, keyPath, { ...currentContainer, skillsmith: entryValue })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  return { status: 'created', path, backupPath }
}

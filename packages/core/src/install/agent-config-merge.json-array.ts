/**
 * JSON array-entry merge for hook-config wiring (SMI-5456 Wave 1 Step 5).
 *
 * The MCP-server merge (`agent-config-merge.json.ts`) sets a single named
 * key (`skillsmith`) and so can genuinely conflict with a foreign value at
 * that key. Hook config is different: harnesses model hooks as an ARRAY of
 * matcher entries, and we only ever add/update the one entry whose `command`
 * is our own hook script's absolute path — every other array entry (a
 * user's own hooks, or entries for other tools) is left untouched. There is
 * no foreign-entry conflict case for an array append.
 *
 * @module @skillsmith/core/install/agent-config-merge.json-array
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { deepEqualJson, markBackedUp, shouldBackup } from './agent-config-merge.types.js'
import type { MergeResult } from './agent-config-merge.types.js'

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
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[key] = {}
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

export interface JsonArrayMergeOptions {
  path: string
  /** Key path to the array (created as `[]` if any segment is missing). */
  keyPath: readonly string[]
  /** The entry to add/update. */
  entry: unknown
  /** Identifies "our" entry among existing array items (e.g. by embedded script path). */
  isOurEntry: (item: unknown) => boolean
  backupDir: string
  /** See `MergeOptions.alreadyBackedUpPaths` — claude-code merges hooks AND MCP registration into the same `settings.json` per install run. */
  alreadyBackedUpPaths?: Set<string>
}

/** Add or update our entry in a JSON array at `keyPath`, leaving every other array item untouched. */
export function mergeJsonArrayEntry(opts: JsonArrayMergeOptions): MergeResult {
  const { path, keyPath, entry, isOurEntry, backupDir, alreadyBackedUpPaths } = opts

  let doc: Record<string, unknown> = {}
  const existed = existsSync(path)
  if (existed) {
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

  const rawArray = getAtPath(doc, keyPath)
  const array: unknown[] = Array.isArray(rawArray) ? [...rawArray] : []
  const existingIndex = array.findIndex(isOurEntry)

  if (existingIndex >= 0) {
    if (deepEqualJson(array[existingIndex], entry)) {
      return { status: 'unchanged', path, backupPath: null }
    }
    const backupPath =
      existed && shouldBackup(path, alreadyBackedUpPaths) ? writeBackup(path, backupDir) : null
    markBackedUp(path, alreadyBackedUpPaths)
    array[existingIndex] = entry
    setAtPath(doc, keyPath, array)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    return { status: 'updated', path, backupPath }
  }

  const backupPath =
    existed && shouldBackup(path, alreadyBackedUpPaths) ? writeBackup(path, backupDir) : null
  markBackedUp(path, alreadyBackedUpPaths)
  array.push(entry)
  setAtPath(doc, keyPath, array)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  // Always 'created' — see the identical rationale in
  // agent-config-merge.toml-block.ts's final branch: our array entry didn't
  // exist before, regardless of whether the surrounding file (or an array
  // entry a DIFFERENT key path already added this run — e.g. claude-code's
  // SessionStart hook creating settings.json before SessionEnd's array
  // merge runs) pre-existed.
  return { status: 'created', path, backupPath }
}

/**
 * YAML config-merge helper for Hermes (SMI-5456 Wave 1 Step 5).
 *
 * Hermes is the one target harness whose MCP config is YAML
 * (`~/.hermes/config.yaml`, key `mcp_servers:` — spike report §(b),
 * well-verified against three independent official doc pages). The repo
 * already carries a real `yaml` dependency (`packages/core/package.json` /
 * root `package.json`, `"yaml": "^2.8.3"` — also already used by
 * `packages/core/src/services/agent-pack/agent-pack.test.ts`), so this uses
 * the library's parse/stringify round-trip rather than the textual
 * delimited-block scheme the task brief allowed as a fallback for "no YAML
 * dep" — that fallback does not apply here since the dependency exists, and
 * a structured parse is strictly safer than text-splicing a user's own YAML
 * (correct handling of comments/anchors/existing `mcp_servers` siblings).
 *
 * @module @skillsmith/core/install/agent-config-merge.yaml
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parse, stringify } from 'yaml'

import {
  deepEqualJson,
  looksLikeOurMcpEntry,
  markBackedUp,
  shouldBackup,
  type MergeOptions,
  type MergeResult,
} from './agent-config-merge.types.js'

function writeBackup(sourcePath: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = sourcePath.split('/').pop() ?? 'config'
  const backupPath = join(backupDir, `${stamp}-${baseName}.bak`)
  writeFileSync(backupPath, readFileSync(sourcePath, 'utf-8'), { mode: 0o600 })
  return backupPath
}

/**
 * Merge a `skillsmith` entry into `mcp_servers:` of a YAML config file.
 * Same created/updated/unchanged/conflict/error contract as
 * {@link import('./agent-config-merge.json.js').mergeJsonMcpEntry}.
 */
export function mergeYamlMcpEntry(opts: MergeOptions & { mcpServersKey: string }): MergeResult {
  const { path, entryValue, backupDir, force = false, mcpServersKey, alreadyBackedUpPaths } = opts

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
      const parsed: unknown = raw.trim().length === 0 ? {} : parse(raw)
      if (parsed === null || parsed === undefined) {
        doc = {}
      } else if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'error', path, backupPath: null, errorMessage: 'not a YAML mapping' }
      } else {
        doc = parsed as Record<string, unknown>
      }
    } catch (e) {
      return { status: 'error', path, backupPath: null, errorMessage: (e as Error).message }
    }
  }

  const container =
    doc[mcpServersKey] &&
    typeof doc[mcpServersKey] === 'object' &&
    !Array.isArray(doc[mcpServersKey])
      ? (doc[mcpServersKey] as Record<string, unknown>)
      : {}
  const existingEntry = container.skillsmith

  if (existingEntry !== undefined) {
    if (deepEqualJson(existingEntry, entryValue)) {
      return { status: 'unchanged', path, backupPath: null }
    }
    if (!looksLikeOurMcpEntry(existingEntry) && !force) {
      return { status: 'conflict', path, backupPath: null }
    }
    const backupPath =
      existed && shouldBackup(path, alreadyBackedUpPaths) ? writeBackup(path, backupDir) : null
    markBackedUp(path, alreadyBackedUpPaths)
    doc[mcpServersKey] = { ...container, skillsmith: entryValue }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, stringify(doc), { mode: 0o600 })
    return { status: 'updated', path, backupPath }
  }

  const backupPath =
    existed && shouldBackup(path, alreadyBackedUpPaths) ? writeBackup(path, backupDir) : null
  markBackedUp(path, alreadyBackedUpPaths)
  doc[mcpServersKey] = { ...container, skillsmith: entryValue }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, stringify(doc), { mode: 0o600 })
  return { status: 'created', path, backupPath }
}

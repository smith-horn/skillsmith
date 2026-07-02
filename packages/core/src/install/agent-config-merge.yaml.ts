/**
 * YAML config-merge helper for Hermes (SMI-5456 Wave 1 Step 5).
 *
 * Hermes is the one target harness whose MCP config is YAML
 * (`~/.hermes/config.yaml`, key `mcp_servers:` — spike report §(b),
 * well-verified against three independent official doc pages). The repo
 * already carries a real `yaml` dependency (`packages/core/package.json` /
 * root `package.json`, `"yaml": "^2.8.3"` — also already used by
 * `packages/core/src/services/agent-pack/agent-pack.test.ts`), so this uses
 * the library's structured Document API (`parseDocument`/`Document#setIn`)
 * rather than the textual delimited-block scheme the task brief allowed as a
 * fallback for "no YAML dep" — that fallback does not apply here since the
 * dependency exists.
 *
 * GOVERNANCE FIX (SMI-5456 code review, 2026-07-01): this module originally
 * used the library's plain `parse`/`stringify` functions. Those DISCARD
 * every comment in the source file on round-trip (verified: `# top comment`
 * + `# a server` + a trailing inline `# inline comment` all vanish after a
 * `parse` → mutate → `stringify` cycle) — a straightforward
 * preserve-user-content violation for anyone who annotates their own
 * `~/.hermes/config.yaml`. `yaml`'s `Document`/`parseDocument`/`setIn` API
 * operates on the CST and round-trips comments, anchors, and key ordering
 * untouched, only rewriting the one path this module actually sets — see the
 * in-container verification in the SMI-5456 code review report. One
 * documented gap remains: a source file whose root is YAML-null (`~`/`null`,
 * or a fully empty document) with a comment attached to that null node loses
 * that specific comment when the null root is replaced with a fresh mapping
 * (there is no collection node for `setIn` to attach into) — an edge case for
 * a config file that carries no actual config, accepted rather than adding a
 * bespoke CST-splicing path for it.
 *
 * @module @skillsmith/core/install/agent-config-merge.yaml
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Document, isMap, isScalar, parseDocument } from 'yaml'

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

/** Unwrap a `yaml` Document node (or plain value) into a plain JS value for comparison. */
function toPlainValue(node: unknown): unknown {
  if (
    node &&
    typeof node === 'object' &&
    'toJSON' in node &&
    typeof (node as { toJSON: unknown }).toJSON === 'function'
  ) {
    return (node as { toJSON: () => unknown }).toJSON()
  }
  return node
}

/**
 * Merge a `skillsmith` entry into `mcp_servers:` of a YAML config file.
 * Same created/updated/unchanged/conflict/error contract as
 * {@link import('./agent-config-merge.json.js').mergeJsonMcpEntry}. Uses the
 * `yaml` package's `Document` (CST-backed) API so every comment, anchor, and
 * unrelated key in the user's file survives the merge byte-for-byte except
 * for the one path this function actually sets — see module header.
 */
export function mergeYamlMcpEntry(opts: MergeOptions & { mcpServersKey: string }): MergeResult {
  const { path, entryValue, backupDir, force = false, mcpServersKey, alreadyBackedUpPaths } = opts

  let doc: Document
  const existed = existsSync(path)
  if (existed) {
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (e) {
      return { status: 'error', path, backupPath: null, errorMessage: (e as Error).message }
    }
    if (raw.trim().length === 0) {
      doc = new Document({})
    } else {
      const parsed = parseDocument(raw)
      if (parsed.errors.length > 0) {
        return {
          status: 'error',
          path,
          backupPath: null,
          errorMessage: parsed.errors[0]?.message ?? 'YAML parse error',
        }
      }
      if (parsed.contents !== null && isScalar(parsed.contents) && parsed.contents.value === null) {
        // YAML-null root (`~`, `null`, or comments-only-then-null) — treat as
        // an empty mapping, matching the JSON merge helper's "missing file is
        // treated as {}" behavior. A fresh `Document` (rather than mutating
        // `parsed.contents` in place) sidesteps `Document.Parsed`'s stricter
        // `ParsedNode`-only contents typing; behaviorally identical either
        // way since a bare null-root file carries no salvageable structure.
        // Documented CST-comment-loss edge case for this specific shape —
        // see module header.
        doc = new Document({})
      } else if (parsed.contents !== null && !isMap(parsed.contents)) {
        return { status: 'error', path, backupPath: null, errorMessage: 'not a YAML mapping' }
      } else {
        doc = parsed
      }
    }
  } else {
    doc = new Document({})
  }

  const existingEntry = toPlainValue(doc.getIn([mcpServersKey, 'skillsmith']))

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
    doc.setIn([mcpServersKey, 'skillsmith'], entryValue)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, doc.toString(), { mode: 0o600 })
    return { status: 'updated', path, backupPath }
  }

  const backupPath =
    existed && shouldBackup(path, alreadyBackedUpPaths) ? writeBackup(path, backupDir) : null
  markBackedUp(path, alreadyBackedUpPaths)
  doc.setIn([mcpServersKey, 'skillsmith'], entryValue)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, doc.toString(), { mode: 0o600 })
  return { status: 'created', path, backupPath }
}

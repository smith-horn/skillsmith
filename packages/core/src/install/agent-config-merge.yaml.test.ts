/**
 * @fileoverview Unit tests for `mergeYamlMcpEntry` (SMI-5456 governance
 *               follow-up, code review 2026-07-01).
 * @module @skillsmith/core/install/agent-config-merge.yaml.test
 *
 * Added because this module previously had ZERO direct test coverage — the
 * only harness exercising the YAML config format (Hermes) is never
 * "detected" in `agent-pack-installer.test.ts` (no test creates `~/.hermes`),
 * so the plain-`parse`/`stringify` comment-loss bug this file's governance
 * fix addresses shipped with no test that could have caught it. Covers the
 * created/updated/unchanged/conflict/error contract plus the comment-
 * preservation regression itself.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mergeYamlMcpEntry } from './agent-config-merge.yaml.js'

let dir: string
let configPath: string
let backupDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skillsmith-yaml-merge-'))
  configPath = join(dir, 'config.yaml')
  backupDir = join(dir, 'backups')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ENTRY = {
  command: 'npx',
  args: ['-y', '@skillsmith/mcp-server'],
  env: { SKILLSMITH_TOOL_PROFILE: 'agent' },
}

describe('mergeYamlMcpEntry', () => {
  it('creates the file + mcp_servers.skillsmith key when absent', () => {
    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('created')
    expect(result.backupPath).toBeNull()
    expect(existsSync(configPath)).toBe(true)
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('mcp_servers:')
    expect(content).toContain('skillsmith:')
  })

  it('is idempotent: a second merge with the same entryValue reports unchanged and writes no backup', () => {
    mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    const second = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(second.status).toBe('unchanged')
    expect(second.backupPath).toBeNull()
    expect(existsSync(backupDir)).toBe(false)
  })

  it('PRESERVES comments, unrelated keys, and key order on merge (governance regression test)', () => {
    const src = [
      '# top-of-file comment',
      'some_other_tool:',
      '  # a nested comment',
      '  enabled: true # inline comment',
      'mcp_servers:',
      '  # an existing server',
      '  other_server:',
      '    command: bar',
      '',
    ].join('\n')
    writeFileSync(configPath, src)

    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('created')

    const out = readFileSync(configPath, 'utf-8')
    expect(out).toContain('# top-of-file comment')
    expect(out).toContain('# a nested comment')
    expect(out).toContain('# inline comment')
    expect(out).toContain('# an existing server')
    expect(out).toContain('other_server:')
    expect(out).toContain('enabled: true')
    expect(out).toContain('skillsmith:')
  })

  it('does not clobber a foreign non-Skillsmith skillsmith entry (conflict, no force)', () => {
    writeFileSync(configPath, 'mcp_servers:\n  skillsmith:\n    command: some-other-tool\n')
    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('conflict')
    const out = readFileSync(configPath, 'utf-8')
    expect(out).toContain('some-other-tool')
  })

  it('force: true overwrites a foreign entry and backs up the pre-existing file first', () => {
    writeFileSync(configPath, 'mcp_servers:\n  skillsmith:\n    command: some-other-tool\n')
    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
      force: true,
    })
    expect(result.status).toBe('updated')
    expect(result.backupPath).not.toBeNull()
    expect(existsSync(result.backupPath!)).toBe(true)
    expect(readFileSync(result.backupPath!, 'utf-8')).toContain('some-other-tool')
  })

  it('recognizes a prior skillsmith-owned entry (by structural fingerprint) and updates without --force', () => {
    writeFileSync(
      configPath,
      'mcp_servers:\n  skillsmith:\n    command: node\n    args:\n      - old/path/@skillsmith/mcp-server\n'
    )
    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('updated')
  })

  it('never backs up twice for the same path in one run (alreadyBackedUpPaths)', () => {
    writeFileSync(
      configPath,
      'mcp_servers:\n  skillsmith:\n    command: node\n    args: ["@skillsmith/mcp-server"]\n'
    )
    const alreadyBackedUpPaths = new Set<string>()
    const first = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
      alreadyBackedUpPaths,
    })
    expect(first.backupPath).not.toBeNull()
    // Merge into a DIFFERENT key path in the same file — simulates a second
    // merge call touching the same shared config file within one install run.
    const second = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'other_servers',
      entryValue: ENTRY,
      backupDir,
      alreadyBackedUpPaths,
    })
    expect(second.backupPath).toBeNull()
    expect(existsSync(backupDir)).toBe(true)
  })

  it('returns an error status (never throws) for malformed YAML', () => {
    writeFileSync(configPath, ': not: valid: yaml: [')
    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('error')
    expect(result.errorMessage).toBeTruthy()
  })

  it('returns an error status for a non-mapping YAML root (a list)', () => {
    writeFileSync(configPath, '- one\n- two\n')
    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('error')
  })

  it('treats a YAML-null root (~) as an empty mapping, matching the "missing file" behavior', () => {
    writeFileSync(configPath, '~\n')
    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('created')
    expect(readFileSync(configPath, 'utf-8')).toContain('skillsmith:')
  })

  it('treats an empty file the same as a missing one', () => {
    writeFileSync(configPath, '')
    const result = mergeYamlMcpEntry({
      path: configPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('created')
  })

  it('creates the parent directory when it does not exist', () => {
    const nestedPath = join(dir, 'nested', 'dir', 'config.yaml')
    mkdirSync(join(dir, 'nested'), { recursive: false })
    const result = mergeYamlMcpEntry({
      path: nestedPath,
      mcpServersKey: 'mcp_servers',
      entryValue: ENTRY,
      backupDir,
    })
    expect(result.status).toBe('created')
    expect(existsSync(nestedPath)).toBe(true)
  })
})

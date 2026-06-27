/**
 * @fileoverview SMI-5407 end-to-end — MCP `skill_recover_source` via real dispatch.
 *
 * Drives the production dispatch path (`dispatchProvenanceTool`) against a REAL
 * temp filesystem fixture and a REAL offline ToolContext (in-memory `skills`).
 * Asserts the per-directory recovery report AND that the tool is read-only —
 * the on-disk manifest sentinel is byte-identical after the call.
 *
 * $HOME is set to the temp home BEFORE the dynamic import of the dispatch module
 * (the install.types module-level MANIFEST_PATH freezes at import time), per the
 * read-only guarantee under test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContext } from '../context.js'
import { writeSourceFixture, FIXTURE_DIRS, GIT_OWNER, GIT_REPO } from './source-recovery-fixture.js'

interface RecoveryResult {
  skillName: string
  method: string | null
  confidence: string
  status: string
  candidates: unknown[]
  recoveredSource: { owner: string; repo: string; url: string } | null
}

let dispatchProvenanceTool: (
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: ToolContext
) => Promise<CallToolResult>
let createTestContext: () => Promise<ToolContext>
let disposeTestContext: (ctx: ToolContext) => Promise<void>

let context: ToolContext
let tmpHome = ''
let manifestPath = ''
let sentinel = ''
let originalHome: string | undefined

beforeAll(async () => {
  originalHome = process.env['HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-mcp-home-'))
  process.env['HOME'] = tmpHome

  // Fixture lives under the homeDir-derived skills root.
  writeSourceFixture(path.join(tmpHome, '.claude', 'skills'))

  // Sentinel manifest to prove the tool never mutates it.
  manifestPath = path.join(tmpHome, '.skillsmith', 'manifest.json')
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  sentinel = JSON.stringify({ version: '1.0.0', installedSkills: {} }, null, 2)
  fs.writeFileSync(manifestPath, sentinel)
  ;({ dispatchProvenanceTool } = await import('../provenance-tool-dispatch.js'))
  ;({ createTestContext, disposeTestContext } = await import('./test-utils.js'))

  context = await createTestContext() // offline, in-memory skills DB
  context.skillRepository.create({
    id: 'reg-uuid-mcp',
    name: FIXTURE_DIRS.registry,
    repoUrl: 'https://github.com/regowner/regrepo',
    qualityScore: 0.7,
    trustTier: 'community',
  })
  context.skillRepository.create({
    id: 'coll-uuid-mcp-1',
    name: FIXTURE_DIRS.collision,
    repoUrl: 'https://github.com/coll1/repoA',
    qualityScore: 0.6,
    trustTier: 'community',
  })
  context.skillRepository.create({
    id: 'coll-uuid-mcp-2',
    name: FIXTURE_DIRS.collision,
    repoUrl: 'https://github.com/coll2/repoB',
    qualityScore: 0.6,
    trustTier: 'community',
  })
})

afterAll(async () => {
  if (context) await disposeTestContext(context)
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true })
})

function parseReport(result: CallToolResult): {
  skills: RecoveryResult[]
  summary: Record<string, number>
} {
  expect(result.isError).toBe(false)
  const text = (result.content[0] as { text: string }).text
  return JSON.parse(text)
}

function bySkill(skills: RecoveryResult[], name: string): RecoveryResult {
  const found = skills.find((s) => s.skillName === name)
  if (!found) throw new Error(`fixture skill not found in report: ${name}`)
  return found
}

describe('SMI-5407 e2e — skill_recover_source MCP dispatch (scenario 5)', () => {
  it('returns the per-directory recovery report via the real dispatch path', async () => {
    const result = await dispatchProvenanceTool(
      'skill_recover_source',
      { homeDir: tmpHome },
      context
    )
    const { skills, summary } = parseReport(result)

    const git = bySkill(skills, FIXTURE_DIRS.git)
    expect(git.method).toBe('git-remote')
    expect(git.confidence).toBe('exact')
    expect(git.recoveredSource?.owner).toBe(GIT_OWNER)
    expect(git.recoveredSource?.repo).toBe(GIT_REPO)

    expect(bySkill(skills, FIXTURE_DIRS.https).method).toBe('git-remote')

    const plugin = bySkill(skills, FIXTURE_DIRS.plugin)
    expect(plugin.method).toBe('plugin-json')
    expect(plugin.confidence).toBe('high')

    const registry = bySkill(skills, FIXTURE_DIRS.registry)
    expect(registry.method).toBe('registry-name')
    expect(registry.confidence).toBe('medium')
    expect(registry.status).toBe('recovered')

    const collision = bySkill(skills, FIXTURE_DIRS.collision)
    expect(collision.candidates).toHaveLength(2)
    expect(collision.confidence).toBe('low')
    expect(collision.status).toBe('unknown')

    expect(bySkill(skills, FIXTURE_DIRS.backup).status).toBe('skipped_backup')
    expect(bySkill(skills, FIXTURE_DIRS.unknown).status).toBe('unknown')

    expect(summary.total).toBe(skills.length)
    expect(summary.skipped_backup).toBe(1)
  })

  it('is read-only — the on-disk manifest is unchanged after the call', async () => {
    await dispatchProvenanceTool('skill_recover_source', { homeDir: tmpHome }, context)
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(sentinel)
  })
})

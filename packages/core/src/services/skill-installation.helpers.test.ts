/**
 * @fileoverview Tests for the SMI-5676 `.mcp.json` cross-check additions to
 *   skill-installation.helpers.ts (`getRegisteredMcpServers`, and the
 *   resolution-aware warning filtering in `extractDepIntel`).
 * @module @skillsmith/core/services/skill-installation.helpers.test
 * @see SMI-5676: Wave 1 Step 3b — harden extractMcpReferences
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { extractDepIntel, getRegisteredMcpServers } from './skill-installation.helpers.js'

describe('getRegisteredMcpServers (SMI-5676)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-mcp-json-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined when .mcp.json does not exist (fail open)', () => {
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })

  it('returns the registered server names when .mcp.json is valid', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { ruflo: {}, skillsmith: {} } })
    )
    expect(getRegisteredMcpServers(tmpDir)).toEqual(['ruflo', 'skillsmith'])
  })

  it('returns an empty array when mcpServers is present but empty (checked, found nothing)', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    expect(getRegisteredMcpServers(tmpDir)).toEqual([])
  })

  it('fails open (returns undefined) on unparseable JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{ not valid json')
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })

  it('fails open (returns undefined) when the mcpServers key is missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ foo: 'bar' }))
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })

  it('fails open (returns undefined) when mcpServers is not an object', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: 'nope' }))
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })

  it('fails open (returns undefined) when mcpServers is an array', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: ['ruflo'] }))
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })
})

describe('extractDepIntel resolution-aware warnings (SMI-5676)', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-dep-intel-'))
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does not warn about a server confirmed registered in .mcp.json', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { linear: {} } }))
    process.chdir(tmpDir)

    const result = extractDepIntel('Use mcp__linear__save_issue to create issues.')

    expect(result.dep_inferred_servers).toContain('linear')
    expect(result.dep_warnings.some((w) => w.includes('linear'))).toBe(false)
  })

  it('warns about a server absent from .mcp.json (e.g. the claude-flow -> ruflo rename)', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { ruflo: {} } }))
    process.chdir(tmpDir)

    const result = extractDepIntel('Use mcp__claude-flow__agent_spawn to spawn agents.')

    expect(result.dep_inferred_servers).toContain('claude-flow')
    expect(result.dep_warnings.some((w) => w.includes('claude-flow'))).toBe(true)
  })

  it('still warns when .mcp.json is missing (fail open -> unknown, not silently trusted)', () => {
    process.chdir(tmpDir) // no .mcp.json written

    const result = extractDepIntel('Use mcp__linear__save_issue to create issues.')

    expect(result.dep_warnings.some((w) => w.includes('linear'))).toBe(true)
  })
})

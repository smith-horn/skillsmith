/**
 * @see SMI-5407 — plugin manifest source recovery
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { parsePluginManifestRepository } from '../../src/provenance/plugin-manifest.js'

const tracked: string[] = []

function makePluginDir(manifest: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-plug-'))
  tracked.push(dir)
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  return dir
}

afterEach(() => {
  for (const dir of tracked.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('parsePluginManifestRepository', () => {
  it('handles a string repository', () => {
    const dir = makePluginDir({ name: 'p', repository: 'https://github.com/owner/repo' })
    expect(parsePluginManifestRepository(dir)).toEqual({
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
    })
  })

  it('handles an object { url } repository', () => {
    const dir = makePluginDir({ repository: { type: 'git', url: 'git@github.com:owner/repo.git' } })
    expect(parsePluginManifestRepository(dir)).toEqual({
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
    })
  })

  it('returns null when plugin.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-plug-'))
    tracked.push(dir)
    expect(parsePluginManifestRepository(dir)).toBeNull()
  })

  it('returns null when the repository field is absent', () => {
    const dir = makePluginDir({ name: 'p' })
    expect(parsePluginManifestRepository(dir)).toBeNull()
  })
})

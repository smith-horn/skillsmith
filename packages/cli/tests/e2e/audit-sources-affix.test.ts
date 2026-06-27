/**
 * @fileoverview SMI-5413 e2e — affix-tolerant registry-name recovery.
 *
 * A skill installed under a SHORT local dir name (`affixdemo`) is recovered from
 * its `claude-skill-affixdemo` registry entry; an EXACT name match is preferred
 * over affix variants so a clean hit is never downgraded to ambiguous. Real temp
 * filesystem + real temp SQLite (seeded `skills`); $HOME redirected before the
 * dynamic import so the action's module-level MANIFEST_PATH freezes onto it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { skillMd, seedSkillsDb } from './utils/source-recovery-fixture.js'
import type { AuditSourcesOptions } from '../../src/commands/audit-sources.action.js'
import type { SkillRecoveryResult } from '@skillsmith/core'

let runAuditSources: (o: AuditSourcesOptions) => Promise<void>
let tempHome = ''
let originalHome: string | undefined

beforeAll(async () => {
  originalHome = process.env['HOME']
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5413-home-'))
  process.env['HOME'] = tempHome
  ;({ runAuditSources } = await import('../../src/commands/audit-sources.action.js'))
})

afterAll(() => {
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true })
})

function writeLocalSkill(root: string, name: string): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(name))
}

function makeOpts(skillsRoot: string, db: string): AuditSourcesOptions {
  return {
    skillsRoot,
    apply: false,
    yes: false,
    set: undefined,
    minConfidence: 'high',
    json: true,
    embedding: false,
    catalogHint: false,
    writeFrontmatter: false,
    forceWriteFrontmatter: false,
    db,
  }
}

async function recover(skillsRoot: string, db: string): Promise<SkillRecoveryResult[]> {
  const chunks: string[] = []
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
      return true
    })
  try {
    await runAuditSources(makeOpts(skillsRoot, db))
  } finally {
    spy.mockRestore()
  }
  return (JSON.parse(chunks.join('').trim()) as { skills: SkillRecoveryResult[] }).skills
}

function tmpRoot(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `smi5413-${tag}-`))
}

function tmpDb(tag: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `smi5413-db-${tag}-`)), 'skills.db')
}

describe('SMI-5413 e2e — affix-tolerant registry-name recovery', () => {
  it('recovers a short local name from its claude-skill-<name> registry entry', async () => {
    const root = tmpRoot('affix')
    writeLocalSkill(root, 'affixdemo')
    const db = tmpDb('affix')
    await seedSkillsDb(db, [
      {
        id: 'uuid-affix',
        name: 'claude-skill-affixdemo',
        repoUrl: 'https://github.com/wrsmith108/claude-skill-affixdemo',
        qualityScore: 0.5,
      },
    ])

    const skills = await recover(root, db)
    const s = skills.find((x) => x.skillName === 'affixdemo')
    expect(s?.method).toBe('registry-name')
    expect(s?.confidence).toBe('medium')
    expect(s?.recoveredSource?.url).toBe('https://github.com/wrsmith108/claude-skill-affixdemo')
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('prefers an EXACT name match over affix variants (no ambiguous downgrade)', async () => {
    const root = tmpRoot('exact')
    writeLocalSkill(root, 'affixdemo')
    const db = tmpDb('exact')
    // Both an exact `affixdemo` and an affixed `claude-skill-affixdemo` exist;
    // the exact one must win as a single medium candidate, not become low/ambiguous.
    await seedSkillsDb(db, [
      {
        id: 'uuid-exact',
        name: 'affixdemo',
        repoUrl: 'https://github.com/someone/affixdemo',
        qualityScore: 0.4,
      },
      {
        id: 'uuid-affix2',
        name: 'claude-skill-affixdemo',
        repoUrl: 'https://github.com/wrsmith108/claude-skill-affixdemo',
        qualityScore: 0.9,
      },
    ])

    const skills = await recover(root, db)
    const s = skills.find((x) => x.skillName === 'affixdemo')
    expect(s?.confidence).toBe('medium')
    expect(s?.recoveredSource?.url).toBe('https://github.com/someone/affixdemo')
    fs.rmSync(root, { recursive: true, force: true })
  })
})

/**
 * @see SMI-5407 — manifest backfill (id/source rules, never-clobber, idempotency)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { backfillManifest } from '../../src/provenance/backfill.js'
import { hashContent } from '../../src/services/skill-installation.helpers.js'
import type {
  RecoveryConfidence,
  RecoveryReport,
  RecoverySummary,
  SkillRecoveryResult,
} from '../../src/provenance/types.js'
import type {
  SkillManifest,
  SkillManifestEntry,
} from '../../src/services/skill-installation.types.js'

const NOW = '2026-06-25T00:00:00.000Z'
const SKILL_CONTENT = '---\nname: x\n---\nbody'

let root = ''
let manifestPath = ''

function mkSkillDir(name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_CONTENT)
  return dir
}

function report(...skills: SkillRecoveryResult[]): RecoveryReport {
  const summary: RecoverySummary = {
    total: skills.length,
    recovered: skills.filter((s) => s.status === 'recovered').length,
    already_tracked: 0,
    unknown: skills.filter((s) => s.status === 'unknown').length,
    skipped_backup: skills.filter((s) => s.status === 'skipped_backup').length,
  }
  return { skills, summary }
}

function gitResult(installPath: string, skillName: string): SkillRecoveryResult {
  return {
    skillName,
    installPath,
    recoveredSource: { owner: 'acme', repo: 'gitrepo', url: 'https://github.com/acme/gitrepo' },
    registryId: null,
    method: 'git-remote',
    confidence: 'exact',
    candidates: [],
    status: 'recovered',
  }
}

function registryResult(
  installPath: string,
  skillName: string,
  confidence: RecoveryConfidence
): SkillRecoveryResult {
  return {
    skillName,
    installPath,
    recoveredSource: { owner: 'acme', repo: 'regrepo', url: 'https://github.com/acme/regrepo' },
    registryId: 'uuid-xyz',
    method: 'registry-name',
    confidence,
    candidates: [],
    status: 'recovered',
  }
}

function loadManifest(): SkillManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SkillManifest
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-bf-'))
  manifestPath = path.join(root, 'manifest.json')
})

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('backfillManifest', () => {
  it('dry-run plans entries but writes nothing', async () => {
    const dir = mkSkillDir('gitskill')
    const outcome = await backfillManifest(report(gitResult(dir, 'gitskill')), {
      manifestPath,
      now: NOW,
    })

    expect(outcome.planned).toHaveLength(1)
    expect(outcome.written).toEqual([])
    expect(fs.existsSync(manifestPath)).toBe(false)
  })

  it('apply writes a registry UUID id and a git owner/repo id with https sources', async () => {
    const gitDir = mkSkillDir('gitskill')
    const regDir = mkSkillDir('regskill')
    const outcome = await backfillManifest(
      report(gitResult(gitDir, 'gitskill'), registryResult(regDir, 'regskill', 'high')),
      { manifestPath, apply: true, now: NOW }
    )

    expect(new Set(outcome.written)).toEqual(new Set(['gitskill', 'regskill']))

    const manifest = loadManifest()

    const git = manifest.installedSkills.gitskill as SkillManifestEntry
    expect(git.id).toBe('acme/gitskill')
    expect(git.source).toBe('https://github.com/acme/gitrepo')
    expect(git.name).toBe('gitskill')
    expect(git.version).toBe('1.0.0')
    expect(git.installPath).toBe(gitDir)
    expect(git.lastUpdated).toBe(NOW)
    expect(typeof git.installedAt).toBe('string')
    expect(Number.isNaN(Date.parse(git.installedAt))).toBe(false)
    expect(git.originalContentHash).toBe(hashContent(SKILL_CONTENT))

    const reg = manifest.installedSkills.regskill as SkillManifestEntry
    expect(reg.id).toBe('uuid-xyz')
    expect(reg.source).toBe('https://github.com/acme/regrepo')
  })

  it('SMI-5411: a git result carrying a registryId writes the UUID id with the git source', async () => {
    const dir = mkSkillDir('gitskill')
    const enriched: SkillRecoveryResult = {
      ...gitResult(dir, 'gitskill'),
      registryId: 'reg-uuid-5411', // git source IS catalog-known -> enriched id
    }
    const outcome = await backfillManifest(report(enriched), {
      manifestPath,
      apply: true,
      now: NOW,
    })

    expect(outcome.written).toEqual(['gitskill'])
    const entry = loadManifest().installedSkills.gitskill as SkillManifestEntry
    // The id is the registry UUID (skill_outdated keys on it), NOT owner/skill-
    // name; the source stays the exact git remote (View-Changes unchanged).
    expect(entry.id).toBe('reg-uuid-5411')
    expect(entry.source).toBe('https://github.com/acme/gitrepo')
  })

  it('default min-confidence (high) excludes a medium registry-name match', async () => {
    const dir = mkSkillDir('namematch')
    const outcome = await backfillManifest(report(registryResult(dir, 'namematch', 'medium')), {
      manifestPath,
      apply: true,
      now: NOW,
    })

    expect(outcome.written).toEqual([])
    expect(outcome.skipped).toContain('namematch')
    expect(fs.existsSync(manifestPath)).toBe(false)
  })

  it('min-confidence medium INCLUDES a single registry-name match and writes its UUID id', async () => {
    const dir = mkSkillDir('namematch')
    const outcome = await backfillManifest(report(registryResult(dir, 'namematch', 'medium')), {
      manifestPath,
      apply: true,
      now: NOW,
      minConfidence: 'medium',
    })

    expect(outcome.written).toEqual(['namematch'])
    const entry = loadManifest().installedSkills.namematch as SkillManifestEntry
    // The registry UUID — NOT owner/skill-name — is the load-bearing id that
    // skill_outdated keys on. Only a registry tier carries it.
    expect(entry.id).toBe('uuid-xyz')
    expect(entry.source).toBe('https://github.com/acme/regrepo')
  })

  it('never writes an ambiguous (low, no recoveredSource) match, even at min-confidence low', async () => {
    const dir = mkSkillDir('ambig')
    const ambiguous: SkillRecoveryResult = {
      skillName: 'ambig',
      installPath: dir,
      recoveredSource: null, // multi-candidate: planResult drops it regardless of floor
      registryId: null,
      method: 'registry-name',
      confidence: 'low',
      candidates: [
        {
          id: 'a',
          name: 'ambig',
          owner: 'o1',
          repo: 'r1',
          url: 'https://github.com/o1/r1',
          qualityScore: 0.5,
        },
        {
          id: 'b',
          name: 'ambig',
          owner: 'o2',
          repo: 'r2',
          url: 'https://github.com/o2/r2',
          qualityScore: 0.5,
        },
      ],
      status: 'unknown',
    }
    const outcome = await backfillManifest(report(ambiguous), {
      manifestPath,
      apply: true,
      now: NOW,
      minConfidence: 'low',
    })

    expect(outcome.written).toEqual([])
    expect(outcome.skipped).toContain('ambig')
    expect(fs.existsSync(manifestPath)).toBe(false)
  })

  it('--set overrides resolve at user-specified and write the https source', async () => {
    const dir = mkSkillDir('manual')
    const unresolved: SkillRecoveryResult = {
      skillName: 'manual',
      installPath: dir,
      recoveredSource: null,
      registryId: null,
      method: null,
      confidence: 'unknown',
      candidates: [],
      status: 'unknown',
    }
    const outcome = await backfillManifest(report(unresolved), {
      manifestPath,
      apply: true,
      now: NOW,
      setOverrides: { manual: 'me/myrepo' },
    })

    expect(outcome.written).toEqual(['manual'])
    const entry = loadManifest().installedSkills.manual as SkillManifestEntry
    expect(entry.id).toBe('me/manual')
    expect(entry.source).toBe('https://github.com/me/myrepo')
  })

  it('never clobbers a healthy existing entry, even when the recovered source differs', async () => {
    const dir = mkSkillDir('existing')
    const existing: SkillManifest = {
      version: '1.0.0',
      installedSkills: {
        existing: {
          id: 'old-id',
          name: 'existing',
          version: '2.5.0',
          source: 'https://github.com/old/old',
          installPath: dir,
          installedAt: '2020-01-01T00:00:00.000Z',
          lastUpdated: '2020-01-01T00:00:00.000Z',
        },
      },
    }
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify(existing))

    const outcome = await backfillManifest(report(gitResult(dir, 'existing')), {
      manifestPath,
      apply: true,
      now: NOW,
    })

    expect(outcome.written).toEqual([])
    expect(outcome.skipped).toContain('existing')

    const entry = loadManifest().installedSkills.existing as SkillManifestEntry
    expect(entry.id).toBe('old-id')
    expect(entry.source).toBe('https://github.com/old/old')
    expect(entry.version).toBe('2.5.0')
  })

  it('fills a missing source onto an unhealthy existing entry without clobbering other fields', async () => {
    const dir = mkSkillDir('partial')
    const existing: SkillManifest = {
      version: '1.0.0',
      installedSkills: {
        partial: {
          id: 'keep-id',
          name: 'partial',
          version: '3.0.0',
          source: '',
          installPath: dir,
          installedAt: '2021-02-02T00:00:00.000Z',
          lastUpdated: '2021-02-02T00:00:00.000Z',
        },
      },
    }
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify(existing))

    const outcome = await backfillManifest(report(gitResult(dir, 'partial')), {
      manifestPath,
      apply: true,
      now: NOW,
    })

    expect(outcome.written).toEqual(['partial'])
    const entry = loadManifest().installedSkills.partial as SkillManifestEntry
    expect(entry.source).toBe('https://github.com/acme/gitrepo')
    expect(entry.id).toBe('keep-id') // preserved
    expect(entry.version).toBe('3.0.0') // preserved
    expect(entry.installedAt).toBe('2021-02-02T00:00:00.000Z') // preserved
  })

  it('is idempotent: a second apply is a no-op', async () => {
    const dir = mkSkillDir('gitskill')
    const rpt = report(gitResult(dir, 'gitskill'))

    const first = await backfillManifest(rpt, { manifestPath, apply: true, now: NOW })
    expect(first.written).toEqual(['gitskill'])

    const before = fs.readFileSync(manifestPath, 'utf-8')
    const second = await backfillManifest(rpt, { manifestPath, apply: true, now: NOW })
    expect(second.written).toEqual([])
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before)
  })

  it('writeFrontmatter adds repository: to a non-git skill, skipping git checkouts', async () => {
    const dir = mkSkillDir('fm')
    await backfillManifest(report(gitResult(dir, 'fm')), {
      manifestPath,
      apply: true,
      now: NOW,
      writeFrontmatter: true,
    })
    const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')
    expect(content).toContain('repository: https://github.com/acme/gitrepo')

    // A real git checkout must never have its frontmatter rewritten.
    const gitDir = mkSkillDir('realgit')
    fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(gitDir, '.git', 'config'), '[remote "origin"]\n\turl = x\n')
    await backfillManifest(report(gitResult(gitDir, 'realgit')), {
      manifestPath,
      apply: true,
      now: NOW,
      writeFrontmatter: true,
    })
    expect(fs.readFileSync(path.join(gitDir, 'SKILL.md'), 'utf-8')).toBe(SKILL_CONTENT)
  })
})

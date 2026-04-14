import { describe, expect, it } from 'vitest'
import { processPackage, TRACKED_PACKAGES } from '../detect-release-drift.mjs'

const corePkg = TRACKED_PACKAGES.find((p) => p.short === 'core')!

function makeIO(overrides: Partial<ReturnType<typeof defaultStubIO>> = {}) {
  return { ...defaultStubIO(), ...overrides }
}

function defaultStubIO() {
  return {
    readPackageVersion: () => '0.5.1',
    readChangelog: () =>
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '- pending',
        '',
        '## v0.5.1',
        '',
        '- Fix: SMI-4182',
        '- Feature: response caching',
        '',
        '## v0.5.0',
        '',
        '- old',
      ].join('\n'),
    npmView: () => true,
    ghReleaseView: () => false,
    ghReleaseCreate: () => ({ ok: true }) as const,
  }
}

describe('processPackage', () => {
  it('no drift when tag already exists', () => {
    const io = makeIO({ ghReleaseView: () => true })
    const result = processPackage(corePkg, io, { dryRun: false })
    expect(result.action).toBe('none')
    expect(result.reason).toBe('tag_exists')
  })

  it('no drift when npm has not published the local version', () => {
    const io = makeIO({ npmView: () => false })
    const result = processPackage(corePkg, io, { dryRun: false })
    expect(result.action).toBe('none')
    expect(result.reason).toBe('npm_not_published')
  })

  it('creates release when drift detected and CHANGELOG has section', () => {
    let created: { tag: string; title: string; notesBody: string } | null = null
    const io = makeIO({
      ghReleaseCreate: (args) => {
        created = args
        return { ok: true }
      },
    })
    const result = processPackage(corePkg, io, { dryRun: false })
    expect(result.action).toBe('created')
    expect(result.reason).toBe('ok')
    expect(created).not.toBeNull()
    expect(created!.tag).toBe('@skillsmith/core-v0.5.1')
    expect(created!.title).toBe('@skillsmith/core v0.5.1')
    expect(created!.notesBody).toContain('SMI-4182')
    expect(created!.notesBody).toContain('response caching')
  })

  it('treats 422/already_exists as success (race with publish.yml)', () => {
    const io = makeIO({
      ghReleaseCreate: () => ({
        ok: false,
        reason: 'already_exists',
        stderr: 'HTTP 422: already_exists\n',
      }),
    })
    const result = processPackage(corePkg, io, { dryRun: false })
    expect(result.action).toBe('none')
    expect(result.reason).toBe('race_already_exists')
  })

  it('propagates real errors', () => {
    const io = makeIO({
      ghReleaseCreate: () => ({
        ok: false,
        reason: 'error',
        stderr: 'HTTP 500: server error',
      }),
    })
    const result = processPackage(corePkg, io, { dryRun: false })
    expect(result.action).toBe('error')
    expect(result.reason).toContain('500')
  })

  it('reports would_create in dry-run mode without calling ghReleaseCreate', () => {
    let createCalled = false
    const io = makeIO({
      ghReleaseCreate: () => {
        createCalled = true
        return { ok: true }
      },
    })
    const result = processPackage(corePkg, io, { dryRun: true })
    expect(result.action).toBe('would_create')
    expect(result.reason).toBe('dry_run')
    expect(createCalled).toBe(false)
  })

  it('skips when CHANGELOG has no baseline (only [Unreleased])', () => {
    const io = makeIO({
      readChangelog: () => '# Changelog\n\n## [Unreleased]\n\n- pending\n',
    })
    const result = processPackage(corePkg, io, { dryRun: false })
    expect(result.action).toBe('skip')
    expect(result.reason).toBe('no_baseline')
  })

  it('skips when CHANGELOG section for the version is missing', () => {
    const io = makeIO({
      readChangelog: () => '# Changelog\n\n## v0.4.0\n\n- old\n\n## v0.3.0\n\n- older\n',
    })
    const result = processPackage(corePkg, io, { dryRun: false })
    expect(result.action).toBe('skip')
    expect(result.reason).toBe('changelog_section_missing')
  })

  it('uses fallback notes when CHANGELOG section is empty', () => {
    let captured: { notesBody: string } | null = null
    const io = makeIO({
      readChangelog: () => '# Changelog\n\n## v0.5.1\n\n## v0.5.0\n\n- old',
      ghReleaseCreate: (args) => {
        captured = args
        return { ok: true }
      },
    })
    const result = processPackage(corePkg, io, { dryRun: false })
    expect(result.action).toBe('created')
    expect(captured!.notesBody).toBe('Release 0.5.1.')
  })
})

describe('TRACKED_PACKAGES', () => {
  it('includes core, mcp-server, cli (not enterprise, not vscode)', () => {
    const shorts = TRACKED_PACKAGES.map((p) => p.short).sort()
    expect(shorts).toEqual(['cli', 'core', 'mcp-server'])
  })

  it('tag prefix matches SMI-4144 plan convention', () => {
    for (const pkg of TRACKED_PACKAGES) {
      expect(pkg.tagPrefix).toMatch(/^@skillsmith\/[a-z-]+-v$/)
      expect(pkg.tagPrefix).toBe(`${pkg.npmName}-v`)
    }
  })
})

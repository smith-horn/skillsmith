/**
 * SMI-6744 Wave 4 M-6 governance finding: Check 74's Layer-X arm gained a
 * second tree assertion (`<root>/node_modules/@claude-flow/cli`) and a
 * `node_modules/.bin/{ruflo,claude-flow,claude-flow-mcp,cli}` symlink judge.
 * Split into its own test file (vs. audit-ruflo-host-paths.test.ts) purely
 * to keep that file under the 500-line policy
 * (scripts/file-length-policy.mjs).
 *
 * Design: docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md
 * § 6 row 6 (M-6).
 */
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import {
  RUFLO_BASH_DENY_ENTRIES,
  evaluateRufloHostPaths,
  rufloHostPathsReportLines,
} from '../audit-ruflo-host-paths-helpers.mjs'
// @ts-expect-error - .mjs helper has no typings
import {
  LAYER_X_BIN_NAMES,
  evaluateLayerXBinEntry,
  evaluateLayerXBinSymlinks,
} from '../audit-ruflo-host-paths-layerx-helpers.mjs'

// All Bash deny entries present, so a test's own assertions are never
// polluted by an unrelated "missing bash entry" FAIL line that happens to
// also mention "@claude-flow/cli" or "ruflo" in its own message text.
function settingsWithAllBashEntries(): string {
  return JSON.stringify({ permissions: { deny: RUFLO_BASH_DENY_ENTRIES } })
}

describe('LAYER_X_BIN_NAMES', () => {
  it('checks exactly the four design-specified names', () => {
    expect(LAYER_X_BIN_NAMES).toEqual(['ruflo', 'claude-flow', 'claude-flow-mcp', 'cli'])
  })
})

describe('evaluateLayerXBinEntry: direct unit tests', () => {
  const scratchDirs: string[] = []
  afterEach(() => {
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    scratchDirs.push(dir)
    return dir
  }

  it('absent path: not present, not a finding', () => {
    const dir = scratchDir('layerx-absent-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    const v = evaluateLayerXBinEntry(dir, 'ruflo')
    expect(v).toMatchObject({ present: false, isSymlink: false, dangling: false, finding: false })
  })

  it('a real file (not a symlink) at the reserved name is not a finding', () => {
    const dir = scratchDir('layerx-realfile-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.bin', 'ruflo'), '#!/bin/sh\necho hi\n')
    const v = evaluateLayerXBinEntry(dir, 'ruflo')
    expect(v).toMatchObject({ present: true, isSymlink: false, finding: false })
  })

  it('positive: a symlink whose target names the "ruflo" segment is a finding', () => {
    const dir = scratchDir('layerx-ruflo-target-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'ruflo', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'ruflo', 'bin', 'ruflo.js'), '')
    symlinkSync('../ruflo/bin/ruflo.js', join(dir, 'node_modules', '.bin', 'ruflo'))
    const v = evaluateLayerXBinEntry(dir, 'ruflo')
    expect(v.finding).toBe(true)
    expect(v.dangling).toBe(false)
  })

  it('positive: .bin/cli judged by TARGET, not name -- a target naming "@claude-flow" is a finding', () => {
    const dir = scratchDir('layerx-cli-target-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', '@claude-flow', 'cli', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '@claude-flow', 'cli', 'bin', 'cli.js'), '')
    symlinkSync('../@claude-flow/cli/bin/cli.js', join(dir, 'node_modules', '.bin', 'cli'))
    const v = evaluateLayerXBinEntry(dir, 'cli')
    expect(v.finding).toBe(true)
  })

  it('negative: .bin/cli pointing at an UNRELATED package is not a finding (name alone is not evidence)', () => {
    const dir = scratchDir('layerx-cli-unrelated-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'not-ruflo-pkg', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'not-ruflo-pkg', 'bin', 'cli.js'), '')
    symlinkSync('../not-ruflo-pkg/bin/cli.js', join(dir, 'node_modules', '.bin', 'cli'))
    const v = evaluateLayerXBinEntry(dir, 'cli')
    expect(v.finding).toBe(false)
    expect(v.target).toContain('not-ruflo-pkg')
  })

  it('negative: a target whose package name merely CONTAINS "ruflo" as a substring is not a finding', () => {
    // Guards the path-segment judgement (not substring) -- "not-ruflo-pkg"
    // must not match a bare `.includes('ruflo')`.
    const dir = scratchDir('layerx-substring-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'not-ruflo-pkg', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'not-ruflo-pkg', 'bin', 'x.js'), '')
    symlinkSync('../not-ruflo-pkg/bin/x.js', join(dir, 'node_modules', '.bin', 'claude-flow'))
    const v = evaluateLayerXBinEntry(dir, 'claude-flow')
    expect(v.finding).toBe(false)
  })

  it('positive: a dangling symlink is a finding even though its target names nothing ruflo-related', () => {
    const dir = scratchDir('layerx-dangling-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    // No target file created -- the symlink is dangling.
    symlinkSync(
      '../some-removed-pkg/bin/x.js',
      join(dir, 'node_modules', '.bin', 'claude-flow-mcp')
    )
    const v = evaluateLayerXBinEntry(dir, 'claude-flow-mcp')
    expect(v.dangling).toBe(true)
    expect(v.finding).toBe(true)
  })

  it('RED (watched failing pre-M6, see report): existsSync-based detection would call a dangling link absent', () => {
    // This is the exact defect M-6 exists to avoid: Node's existsSync()
    // FOLLOWS a symlink, so it reports the dangling link's own PATH as
    // absent, which is why this arm uses lstatSync + readlinkSync instead.
    const dir = scratchDir('layerx-existssync-trap-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    symlinkSync('../removed-pkg/bin/x.js', join(dir, 'node_modules', '.bin', 'ruflo'))
    expect(existsSync(join(dir, 'node_modules', '.bin', 'ruflo'))).toBe(false)
    // ...yet the lstatSync-based judge below correctly still calls it a finding.
    const v = evaluateLayerXBinEntry(dir, 'ruflo')
    expect(v.finding).toBe(true)
  })

  it('evaluateLayerXBinSymlinks checks all four names in order', () => {
    const dir = scratchDir('layerx-all-four-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    const results = evaluateLayerXBinSymlinks(dir)
    expect(results.map((r: { binPath: string }) => r.binPath.split('/').pop())).toEqual(
      LAYER_X_BIN_NAMES
    )
  })
})

describe('evaluateRufloHostPaths + rufloHostPathsReportLines: Layer-X integration (M-6)', () => {
  const scratchDirs: string[] = []
  afterEach(() => {
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    scratchDirs.push(dir)
    return dir
  }

  it('clean tree: cliTreePresent false, no bin findings, all-pass report lines', () => {
    const dir = scratchDir('layerx-clean-')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    const verdict = evaluateRufloHostPaths({
      settingsPath: '.claude/settings.json',
      root: dir,
      readFile: settingsWithAllBashEntries,
    })
    expect(verdict.cliTreePresent).toBe(false)
    expect(verdict.binEntries.every((b: { finding: boolean }) => !b.finding)).toBe(true)
    const lines = rufloHostPathsReportLines(verdict)
    const cliLine = lines.find((l: { message: string }) => l.message.includes('@claude-flow/cli'))
    expect(cliLine?.severity).toBe('pass')
    const binLine = lines.find((l: { message: string }) =>
      l.message.startsWith('Check 74: none of the')
    )
    expect(binLine?.severity).toBe('pass')
  })

  it('RED: @claude-flow/cli tree present (ruflo dir absent) -- watched failing before M-6 landed', () => {
    const dir = scratchDir('layerx-clitree-')
    mkdirSync(join(dir, 'node_modules', '@claude-flow', 'cli'), { recursive: true })
    const verdict = evaluateRufloHostPaths({
      settingsPath: '.claude/settings.json',
      root: dir,
      readFile: settingsWithAllBashEntries,
    })
    // The top-level ruflo tree is absent -- pre-M6 Check 74 would have
    // reported this tree wholly clean, missing the surviving cli re-export.
    expect(verdict.treePresent).toBe(false)
    expect(verdict.cliTreePresent).toBe(true)
    const lines = rufloHostPathsReportLines(verdict)
    const failLine = lines.find(
      (l: { severity: string; message: string }) =>
        l.severity === 'fail' && l.message.includes('@claude-flow/cli')
    )
    expect(failLine).toBeTruthy()
  })

  it('RED: a stale .bin/ruflo symlink is reported as a Check 74 finding', () => {
    const dir = scratchDir('layerx-staleBinFinding-')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'ruflo', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'ruflo', 'bin', 'ruflo.js'), '')
    symlinkSync('../ruflo/bin/ruflo.js', join(dir, 'node_modules', '.bin', 'ruflo'))
    const verdict = evaluateRufloHostPaths({
      settingsPath: '.claude/settings.json',
      root: dir,
      readFile: settingsWithAllBashEntries,
    })
    const lines = rufloHostPathsReportLines(verdict)
    const failLine = lines.find(
      (l: { severity: string; message: string }) =>
        l.severity === 'fail' && l.message.includes('stale bin symlink')
    )
    expect(failLine).toBeTruthy()
    expect(failLine?.message).toContain('.bin/ruflo')
  })
})

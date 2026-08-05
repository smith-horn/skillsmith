/**
 * Tests for CI Supply-Chain Pin Drift Guard (SMI-3985) — Check 4 (SMI-4874):
 * workflow `npm i -g` / `npx` install audit.
 *
 * Split out of check-supply-chain-pins.test.ts (SMI-5931) to keep both
 * files under the repo's 500-line-per-file gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// SMI-4693: realpath-canonical tmpdir for symlink consistency. This file
// does not spawn `git`, so it does not need `makeFixtureEnv` — but using
// `makeFixtureTempDir` keeps the symlink behaviour consistent with the
// rest of the test suite (closes the macOS /var ↔ /private/var asymmetry
// uniformly across fixtures).
import { makeFixtureTempDir } from './_lib/git-fixture-env.js'

// Dynamic import because the module is .mjs (ESM, no .ts transpilation).
const mod = await import('../ci/check-supply-chain-pins.mjs')
const { auditWorkflowInstalls, parsePkgSpec, extractRunBlocks, scanRunBlockForInstalls } = mod as {
  auditWorkflowInstalls: (root: string) => {
    findings: Array<{ file: string; rule: string; message: string; remediation: string }>
    scannedFiles: number
  }
  parsePkgSpec: (spec: string) => { name: string; version: string | null } | null
  extractRunBlocks: (src: string) => Array<{ line: number; body: string }>
  scanRunBlockForInstalls: (
    body: string,
    npmCiSeen: boolean
  ) => Array<{ command: string; pkg: string; reason: string }>
}

describe('SMI-3985: check-supply-chain-pins — run-block installs (SMI-4874)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeFixtureTempDir('scpin')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  describe('parsePkgSpec', () => {
    it('parses a bare package name', () => {
      expect(parsePkgSpec('vercel')).toEqual({ name: 'vercel', version: null })
    })

    it('parses an exact-pinned package', () => {
      expect(parsePkgSpec('vercel@52.2.0')).toEqual({ name: 'vercel', version: '52.2.0' })
    })

    it('parses a scoped package with version', () => {
      expect(parsePkgSpec('@vscode/vsce@2.32.0')).toEqual({
        name: '@vscode/vsce',
        version: '2.32.0',
      })
    })

    it('parses a scoped package without version', () => {
      expect(parsePkgSpec('@vscode/vsce')).toEqual({ name: '@vscode/vsce', version: null })
    })

    it('returns null for shell-like inputs', () => {
      expect(parsePkgSpec('$VAR')).toBeNull()
      expect(parsePkgSpec('-g')).toBeNull()
      expect(parsePkgSpec('')).toBeNull()
    })
  })

  describe('extractRunBlocks', () => {
    it('extracts single-line run: commands', () => {
      const src = ['jobs:', '  build:', '    steps:', '      - run: npm ci'].join('\n')
      const blocks = extractRunBlocks(src)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].body).toBe('npm ci')
    })

    it('extracts pipe-form multi-line run: blocks', () => {
      const src = [
        'jobs:',
        '  build:',
        '    steps:',
        '      - run: |',
        '          PINNED=$(node -p "x")',
        '          npm i -g "vercel@$PINNED"',
        '      - run: npm ci',
      ].join('\n')
      const blocks = extractRunBlocks(src)
      expect(blocks).toHaveLength(2)
      expect(blocks[0].body).toContain('PINNED=')
      expect(blocks[0].body).toContain('npm i -g')
      expect(blocks[1].body).toBe('npm ci')
    })

    it('returns 1-indexed line numbers pointing at the run: line', () => {
      const src = [
        'jobs:', //                  1
        '  build:', //               2
        '    steps:', //             3
        '      - run: echo a', //    4
        '      - run: echo b', //    5
      ].join('\n')
      const blocks = extractRunBlocks(src)
      expect(blocks[0].line).toBe(4)
      expect(blocks[1].line).toBe(5)
    })
  })

  describe('scanRunBlockForInstalls', () => {
    it('case 1: passes on `npm i -g vercel@52.2.0` (exact pin)', () => {
      expect(scanRunBlockForInstalls('npm i -g vercel@52.2.0', false)).toEqual([])
    })

    it('case 2: fails on `npm i -g vercel@latest`', () => {
      const v = scanRunBlockForInstalls('npm i -g vercel@latest', false)
      expect(v).toHaveLength(1)
      expect(v[0].command).toBe('npm i -g')
      expect(v[0].pkg).toBe('vercel@latest')
    })

    it('case 3: fails on `npm i -g vercel` (no version)', () => {
      const v = scanRunBlockForInstalls('npm i -g vercel', false)
      expect(v).toHaveLength(1)
      expect(v[0].reason).toMatch(/no version pin/)
    })

    it('case 4: passes on `npx skillsmith` (allow-list self-test)', () => {
      expect(scanRunBlockForInstalls('npx skillsmith --help', false)).toEqual([])
    })

    it('case 5: passes on `npx sklx@latest` (allow-list, self-test of published package)', () => {
      expect(scanRunBlockForInstalls('npx sklx@latest --version', false)).toEqual([])
    })

    it('case 6: fails on `npx wait-on http://...` (not allow-listed, no version, no preceding npm ci)', () => {
      const v = scanRunBlockForInstalls('npx wait-on http://127.0.0.1:4321/ -t 90000', false)
      expect(v).toHaveLength(1)
      expect(v[0].command).toBe('npx')
      expect(v[0].pkg).toBe('wait-on')
    })

    it('case 7: passes on `npx tsx scripts/foo.ts` (workspace devDep allow-list)', () => {
      expect(scanRunBlockForInstalls('npx tsx scripts/foo.ts', false)).toEqual([])
    })

    it('case 8: passes on `npx some-tool` when npm ci has run earlier in the same job', () => {
      expect(scanRunBlockForInstalls('npx some-tool --flag', true)).toEqual([])
    })

    it('case 9: fails on `npx some-tool` when npm ci has NOT run in the same job', () => {
      const v = scanRunBlockForInstalls('npx some-tool --flag', false)
      expect(v).toHaveLength(1)
      expect(v[0].pkg).toBe('some-tool')
      expect(v[0].reason).toMatch(/post-`npm ci`/)
    })

    it('passes on `npx --yes -p vitest@4.1.2 -- vitest run` (allow-listed via leading flag-skip)', () => {
      // `npx --yes -p vitest@4.1.2 -- vitest run` → first non-flag arg is
      // `vitest@4.1.2` (the `-p` short flag is consumed by the leading
      // flag-skip group). Even without the pin, `vitest` is allow-listed.
      expect(
        scanRunBlockForInstalls('npx --yes -p vitest@4.1.2 -- vitest run tests/eval/', false)
      ).toEqual([])
    })

    it('ignores `pnpm install` (does not collide with `npm install`)', () => {
      expect(scanRunBlockForInstalls('pnpm install foo', false)).toEqual([])
    })

    it('passes on `npx vitest run tests/eval/` (SMI-5931: repo-resolved, no version pin)', () => {
      // `npmCiSeen=false` matters here: `true` would permit any package
      // regardless of the allowlist, so it wouldn't actually assert that
      // `vitest` is allow-listed the way `false` does.
      expect(scanRunBlockForInstalls('npx vitest run tests/eval/', false)).toEqual([])
    })
  })

  describe('auditWorkflowInstalls (integration)', () => {
    it('passes on a workflow whose npx invocations are all allow-listed or post-npm-ci', () => {
      const wfDir = join(tmp, '.github', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(
        join(wfDir, 'good.yml'),
        [
          'name: good',
          'on: push',
          'jobs:',
          '  build:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: npm ci --ignore-scripts',
          '      - run: npx wait-on http://localhost:4321/',
          '      - run: npx skillsmith --help',
          '',
        ].join('\n')
      )
      const result = auditWorkflowInstalls(tmp)
      expect(result.findings).toEqual([])
      expect(result.scannedFiles).toBe(1)
    })

    it('flags `npm i -g pkg@latest` and tracks per-job npm-ci state', () => {
      const wfDir = join(tmp, '.github', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(
        join(wfDir, 'bad.yml'),
        [
          'name: bad',
          'on: push',
          'jobs:',
          '  a:',
          '    steps:',
          '      - run: npm i -g vercel@latest',
          '  b:',
          '    steps:',
          '      - run: npm ci',
          '      - run: npx some-private-tool',
          '  c:',
          '    steps:',
          '      - run: npx other-tool --flag',
          '',
        ].join('\n')
      )
      const result = auditWorkflowInstalls(tmp)
      // Job `a` flagged for vercel@latest. Job `b` passes (post-npm-ci).
      // Job `c` flagged for unpinned other-tool.
      expect(result.findings).toHaveLength(2)
      const messages = result.findings.map((f) => f.message).sort()
      expect(messages[0]).toMatch(/npm i -g.*vercel@latest/)
      expect(messages[1]).toMatch(/npx.*other-tool/)
    })

    it('returns no findings when .github/workflows is absent', () => {
      const result = auditWorkflowInstalls(tmp)
      expect(result.findings).toEqual([])
      expect(result.scannedFiles).toBe(0)
    })

    it('ignores commented-out npm i -g lines', () => {
      const wfDir = join(tmp, '.github', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(
        join(wfDir, 'commented.yml'),
        [
          'name: commented',
          'on: push',
          'jobs:',
          '  build:',
          '    steps:',
          '      # - run: npm i -g vercel@latest',
          '      - run: npm ci',
          '',
        ].join('\n')
      )
      const result = auditWorkflowInstalls(tmp)
      expect(result.findings).toEqual([])
    })

    it('flags the pattern that closed the SMI-4874 gap (vercel@latest)', () => {
      // This is the exact callsite shape Waves A + B removed. Encoding it as
      // a regression test ensures the audit catches the next instance.
      const wfDir = join(tmp, '.github', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(
        join(wfDir, 'regression.yml'),
        [
          'name: regression',
          'on: push',
          'jobs:',
          '  deploy:',
          '    steps:',
          '      - run: |',
          '          npm i -g vercel@latest',
          '          vercel --version',
          '',
        ].join('\n')
      )
      const result = auditWorkflowInstalls(tmp)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0].rule).toBe('workflow-install-pin')
      expect(result.findings[0].file).toContain('regression.yml')
      expect(result.findings[0].message).toContain('vercel@latest')
    })
  })
})

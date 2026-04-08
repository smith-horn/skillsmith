/**
 * Tests for CI Supply-Chain Pin Drift Guard (SMI-3985).
 *
 * Covers the three Wave 1.5 drift checks:
 *   1. `.mcp.json` — no `@latest` in command/args strings
 *   2. esm.sh imports in supabase/functions/**\/*.ts — must be full x.y.z
 *   3. Third-party GitHub Actions in .github/workflows/**\/*.yml — must be
 *      40-char SHA-pinned (first-party actions/* and github/* excluded)
 *
 * Also verifies the git-crypt magic-byte skip path for fork PRs that lack
 * GIT_CRYPT_KEY access to the encrypted supabase/functions tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Dynamic import because the module is .mjs (ESM, no .ts transpilation).
const mod = await import('../ci/check-supply-chain-pins.mjs')
const {
  checkMcpJson,
  checkSupabaseFunctions,
  checkWorkflows,
  extractEsmShPins,
  checkEsmShPin,
  parseUsesRef,
  checkWorkflowUses,
  isGitCryptEncrypted,
  formatFindingsMarkdown,
} = mod as {
  checkMcpJson: (p: string) => Array<{ file: string; rule: string; message: string }>
  checkSupabaseFunctions: (root: string) => {
    findings: Array<{ file: string; rule: string; message: string }>
    encryptedCount: number
    scannedCount: number
  }
  checkWorkflows: (root: string) => Array<{ file: string; rule: string; message: string }>
  extractEsmShPins: (src: string) => Array<{ pkg: string; version: string }>
  checkEsmShPin: (pin: { pkg: string; version: string }) => { ok: boolean; message?: string }
  parseUsesRef: (line: string) => { owner: string; repo: string; ref: string; raw: string } | null
  checkWorkflowUses: (ref: { owner: string; repo: string; ref: string }) => {
    ok: boolean
    message?: string
  }
  isGitCryptEncrypted: (p: string) => boolean
  formatFindingsMarkdown: (
    all: Array<{ file: string; rule: string; message: string; remediation: string }>,
    stats?: { encryptedCount: number; scannedCount: number }
  ) => string
}

describe('SMI-3985: check-supply-chain-pins', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'scpin-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Check 1: .mcp.json
  // -------------------------------------------------------------------------
  describe('checkMcpJson', () => {
    it('passes on a clean .mcp.json with pinned versions', () => {
      const p = join(tmp, '.mcp.json')
      writeFileSync(
        p,
        JSON.stringify({
          mcpServers: {
            skillsmith: { command: 'npx', args: ['-y', '@skillsmith/mcp-server'] },
            ruflo: { command: 'npx', args: ['ruflo@3.5.51', 'mcp', 'start'] },
          },
        })
      )
      expect(checkMcpJson(p)).toEqual([])
    })

    it('fails when any string contains @latest', () => {
      const p = join(tmp, '.mcp.json')
      writeFileSync(
        p,
        JSON.stringify({
          mcpServers: {
            bad: { command: 'npx', args: ['ruflo@latest', 'mcp', 'start'] },
          },
        })
      )
      const findings = checkMcpJson(p)
      expect(findings).toHaveLength(1)
      expect(findings[0].rule).toBe('mcp-latest')
      expect(findings[0].message).toContain('@latest')
    })

    it('fails on nested @latest deep in a config object', () => {
      const p = join(tmp, '.mcp.json')
      writeFileSync(
        p,
        JSON.stringify({
          mcpServers: {
            nested: {
              command: 'npx',
              env: { CMD: 'some-other-tool@latest' },
            },
          },
        })
      )
      const findings = checkMcpJson(p)
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain('some-other-tool@latest')
    })

    it('returns an empty array when .mcp.json is missing', () => {
      const p = join(tmp, '.mcp.json')
      expect(checkMcpJson(p)).toEqual([])
    })

    it('fails with a clear message on invalid JSON', () => {
      const p = join(tmp, '.mcp.json')
      writeFileSync(p, '{not json')
      const findings = checkMcpJson(p)
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toMatch(/Invalid JSON/)
    })
  })

  // -------------------------------------------------------------------------
  // Check 2: esm.sh semver
  // -------------------------------------------------------------------------
  describe('extractEsmShPins', () => {
    it('extracts stripe and supabase-js imports', () => {
      const src = `
        import Stripe from 'https://esm.sh/stripe@20.4.1'
        import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'
      `
      const pins = extractEsmShPins(src)
      expect(pins).toHaveLength(2)
      expect(pins).toContainEqual({ pkg: 'stripe', version: '20.4.1' })
      expect(pins).toContainEqual({ pkg: '@supabase/supabase-js', version: '2.47.0' })
    })

    it('ignores non-esm.sh imports', () => {
      const src = `
        import foo from 'https://other.cdn/foo@1.2.3'
        import bar from './local'
      `
      expect(extractEsmShPins(src)).toHaveLength(0)
    })
  })

  describe('checkEsmShPin', () => {
    it('accepts full semver x.y.z', () => {
      expect(checkEsmShPin({ pkg: 'stripe', version: '20.4.1' }).ok).toBe(true)
    })

    it('accepts semver with prerelease tag', () => {
      expect(checkEsmShPin({ pkg: 'stripe', version: '20.4.1-beta.1' }).ok).toBe(true)
    })

    it('rejects major-only version', () => {
      const r = checkEsmShPin({ pkg: 'stripe', version: '20' })
      expect(r.ok).toBe(false)
      expect(r.message).toContain('not full semver')
    })

    it('rejects minor-only version', () => {
      const r = checkEsmShPin({ pkg: '@supabase/supabase-js', version: '2.47' })
      expect(r.ok).toBe(false)
    })

    it('accepts semver followed by a subpath fragment', () => {
      // esm.sh permits paths like `stripe@20.4.1/lib/foo`; strip before validating.
      expect(checkEsmShPin({ pkg: 'stripe', version: '20.4.1/lib/foo' }).ok).toBe(true)
    })
  })

  describe('checkSupabaseFunctions (integration)', () => {
    it('passes when every .ts file has exact-pinned esm.sh imports', () => {
      const fnDir = join(tmp, 'supabase', 'functions', 'checkout')
      mkdirSync(fnDir, { recursive: true })
      writeFileSync(join(fnDir, 'index.ts'), "import Stripe from 'https://esm.sh/stripe@20.4.1'\n")
      const result = checkSupabaseFunctions(tmp)
      expect(result.findings).toHaveLength(0)
      expect(result.encryptedCount).toBe(0)
      expect(result.scannedCount).toBe(1)
    })

    it('fails when a .ts file has a major-only esm.sh pin', () => {
      const fnDir = join(tmp, 'supabase', 'functions', 'bad')
      mkdirSync(fnDir, { recursive: true })
      writeFileSync(join(fnDir, 'index.ts'), "import Stripe from 'https://esm.sh/stripe@20'\n")
      const result = checkSupabaseFunctions(tmp)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0].rule).toBe('esm-sh-semver')
      expect(result.findings[0].file).toContain('supabase/functions/bad/index.ts')
    })

    it('skips git-crypt encrypted files and reports encryptedCount', () => {
      const fnDir = join(tmp, 'supabase', 'functions', 'encrypted')
      mkdirSync(fnDir, { recursive: true })
      // First 9 bytes are the git-crypt magic header \x00GITCRYPT.
      const encrypted = Buffer.concat([
        Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54]),
        Buffer.from('garbage-after-nonce'),
      ])
      writeFileSync(join(fnDir, 'index.ts'), encrypted)
      const result = checkSupabaseFunctions(tmp)
      expect(result.findings).toHaveLength(0)
      expect(result.encryptedCount).toBe(1)
      expect(result.scannedCount).toBe(0)
    })

    it('returns no findings and no scans when the directory is absent', () => {
      const result = checkSupabaseFunctions(tmp)
      expect(result.findings).toHaveLength(0)
      expect(result.encryptedCount).toBe(0)
      expect(result.scannedCount).toBe(0)
    })
  })

  describe('isGitCryptEncrypted', () => {
    it('returns true for a file with the GITCRYPT magic header', () => {
      const p = join(tmp, 'encrypted.ts')
      writeFileSync(p, Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0xff]))
      expect(isGitCryptEncrypted(p)).toBe(true)
    })

    it('returns false for a plaintext file', () => {
      const p = join(tmp, 'plain.ts')
      writeFileSync(p, "import Stripe from 'https://esm.sh/stripe@20.4.1'\n")
      expect(isGitCryptEncrypted(p)).toBe(false)
    })

    it('returns false for an empty file', () => {
      const p = join(tmp, 'empty.ts')
      writeFileSync(p, '')
      expect(isGitCryptEncrypted(p)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Check 3: Workflow SHA pinning
  // -------------------------------------------------------------------------
  describe('parseUsesRef', () => {
    it('parses a typical SHA-pinned third-party action', () => {
      const r = parseUsesRef('actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd')
      expect(r).not.toBeNull()
      expect(r!.owner).toBe('actions')
      expect(r!.repo).toBe('checkout')
      expect(r!.ref).toBe('de0fac2e4500dabe0009e67214ff5f5447ce83dd')
    })

    it('parses an owner/repo/subpath action', () => {
      const r = parseUsesRef('foo/bar/setup@abc123')
      expect(r).not.toBeNull()
      expect(r!.owner).toBe('foo')
      expect(r!.repo).toBe('bar/setup')
      expect(r!.ref).toBe('abc123')
    })

    it('returns null for local action refs', () => {
      expect(parseUsesRef('./local-action')).toBeNull()
    })

    it('returns null for docker refs', () => {
      expect(parseUsesRef('docker://alpine:3')).toBeNull()
    })

    it('returns null for lines without @ref', () => {
      expect(parseUsesRef('owner/repo')).toBeNull()
    })
  })

  describe('checkWorkflowUses', () => {
    const sha = 'a'.repeat(40)

    it('accepts first-party actions/* with a tag ref', () => {
      expect(checkWorkflowUses({ owner: 'actions', repo: 'checkout', ref: 'v4' }).ok).toBe(true)
    })

    it('accepts first-party github/* with a tag ref', () => {
      expect(checkWorkflowUses({ owner: 'github', repo: 'codeql-action', ref: 'v3' }).ok).toBe(true)
    })

    it('accepts third-party action SHA-pinned', () => {
      expect(checkWorkflowUses({ owner: 'docker', repo: 'build-push-action', ref: sha }).ok).toBe(
        true
      )
    })

    it('rejects third-party action with a tag ref', () => {
      const r = checkWorkflowUses({ owner: 'docker', repo: 'build-push-action', ref: 'v6' })
      expect(r.ok).toBe(false)
      expect(r.message).toContain('not SHA-pinned')
    })

    it('rejects third-party action with a short hex ref', () => {
      const r = checkWorkflowUses({ owner: 'docker', repo: 'build-push-action', ref: 'abc1234' })
      expect(r.ok).toBe(false)
    })

    it('accepts Dependabot-style batch SHA update (any 40-char hex is fine)', () => {
      // Simulates a Dependabot PR bumping multiple third-party action SHAs.
      const shas = ['a'.repeat(40), 'b'.repeat(40), '0123456789abcdef0123456789abcdef01234567']
      for (const s of shas) {
        expect(checkWorkflowUses({ owner: 'docker', repo: 'build-push-action', ref: s }).ok).toBe(
          true
        )
      }
    })
  })

  describe('checkWorkflows (integration)', () => {
    it('passes when all third-party actions are SHA-pinned', () => {
      const wfDir = join(tmp, '.github', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(
        join(wfDir, 'ci.yml'),
        [
          'jobs:',
          '  build:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '      - uses: docker/build-push-action@' + 'a'.repeat(40),
          '      - uses: github/codeql-action@v3',
          '',
        ].join('\n')
      )
      const findings = checkWorkflows(tmp)
      expect(findings).toHaveLength(0)
    })

    it('fails when a third-party action uses a tag ref', () => {
      const wfDir = join(tmp, '.github', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(
        join(wfDir, 'ci.yml'),
        ['jobs:', '  build:', '    steps:', '      - uses: docker/build-push-action@v6', ''].join(
          '\n'
        )
      )
      const findings = checkWorkflows(tmp)
      expect(findings).toHaveLength(1)
      expect(findings[0].rule).toBe('workflow-sha-pin')
      expect(findings[0].message).toContain('docker/build-push-action@v6')
    })

    it('ignores commented-out uses: lines', () => {
      const wfDir = join(tmp, '.github', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(
        join(wfDir, 'ci.yml'),
        ['jobs:', '  build:', '    steps:', '      # - uses: docker/build-push-action@v6', ''].join(
          '\n'
        )
      )
      const findings = checkWorkflows(tmp)
      expect(findings).toHaveLength(0)
    })

    it('returns no findings when .github/workflows is absent', () => {
      expect(checkWorkflows(tmp)).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Report formatting
  // -------------------------------------------------------------------------
  describe('formatFindingsMarkdown', () => {
    it('produces a pass summary when no findings', () => {
      const md = formatFindingsMarkdown([], { encryptedCount: 0, scannedCount: 5 })
      expect(md).toContain('passed')
      expect(md).not.toContain('skipped')
    })

    it('renders a markdown table with findings', () => {
      const md = formatFindingsMarkdown(
        [
          {
            file: '.mcp.json',
            rule: 'mcp-latest',
            message: 'Found @latest',
            remediation: 'Pin it',
          },
        ],
        { encryptedCount: 0, scannedCount: 0 }
      )
      expect(md).toContain('| File | Rule | Issue | Fix |')
      expect(md).toContain('`.mcp.json`')
      expect(md).toContain('mcp-latest')
    })

    it('adds a skipped-coverage warning when encryptedCount > 0', () => {
      const md = formatFindingsMarkdown([], { encryptedCount: 3, scannedCount: 10 })
      expect(md).toContain('esm.sh drift coverage skipped for 3 encrypted file')
      expect(md).toContain('GIT_CRYPT_KEY')
    })

    it('escapes backslashes before pipes to avoid ambiguous markdown (CodeQL js/incomplete-sanitization)', () => {
      // If input already contains a literal `\|`, a naive escape of only `|`
      // would produce `\\|` which is ambiguous. Escaping `\` first yields
      // `\\\|` (backslash-backslash then escaped-pipe) — unambiguous.
      const md = formatFindingsMarkdown(
        [
          {
            file: 'path\\with\\backslash.ts',
            rule: 'esm-sh-pin',
            message: 'bad\\|input',
            remediation: 'fix|it',
          },
        ],
        { encryptedCount: 0, scannedCount: 0 }
      )
      // Backslash doubled, then pipe escaped
      expect(md).toContain('path\\\\with\\\\backslash.ts')
      expect(md).toContain('bad\\\\\\|input')
      expect(md).toContain('fix\\|it')
    })
  })
})

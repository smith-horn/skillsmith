/**
 * Tests for the SMI-5715 internal @skillsmith/*|@smith-horn/* version-
 * coherence gate helper (Check 58 in audit-standards.mjs).
 *
 * Background: `packages/doc-retrieval-mcp/package.json` pinned
 * `@skillsmith/core` to `^0.8.0` while the workspace's actual
 * `@skillsmith/core` version was `0.11.2` — three minor versions of silent
 * drift, invisible because nothing checked that internal dependency ranges
 * track the workspace's actual current versions. It broke both Turborepo's
 * task-graph edge and npm's workspace-symlink resolution on a fresh
 * worktree's first build. See
 * docs/internal/implementation/smi-5715-doc-retrieval-core-version-drift.md
 * for the full root-cause writeup.
 *
 * `evaluateInternalVersionCoherence` is the pure decision layer —
 * Check 58 itself does only the `packages/*` directory walk + `JSON.parse`
 * and hands the parsed package.json content in here, then maps the returned
 * per-entry results to pass()/warn()/fail() calls.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { evaluateInternalVersionCoherence } from '../audit-internal-version-coherence-helpers.mjs'

describe('evaluateInternalVersionCoherence (SMI-5715 Check 58)', () => {
  it('flags a fabricated stale range as a violation (fail-mode case)', () => {
    const packagesByDir = {
      core: { name: '@skillsmith/core', version: '0.11.2' },
      'doc-retrieval-mcp': {
        name: '@skillsmith/doc-retrieval-mcp',
        version: '0.0.1',
        dependencies: { '@skillsmith/core': '^0.8.0' },
      },
    }

    const results = evaluateInternalVersionCoherence(packagesByDir)

    expect(results).toEqual([
      {
        dir: 'doc-retrieval-mcp',
        section: 'dependencies',
        depName: '@skillsmith/core',
        range: '^0.8.0',
        actualVersion: '0.11.2',
        status: 'violation',
      },
    ])
  })

  it('skips a bare "*" range entirely — no ok/violation/dangling entry emitted', () => {
    const packagesByDir = {
      core: { name: '@skillsmith/core', version: '0.11.2' },
      cli: {
        name: '@skillsmith/cli',
        version: '0.8.2',
        peerDependencies: { '@skillsmith/core': '*' },
      },
    }

    const results = evaluateInternalVersionCoherence(packagesByDir)

    expect(results).toEqual([])
  })

  it('warns — does not fail, does not crash — on a dangling/unknown package name', () => {
    // Mirrors the real, currently-known packages/cli/package.json shape:
    // its peer dep is named `@smith-horn/enterprise`, but the actual
    // workspace package is `@smith-horn/enterprise` (SMI-5720, tracked
    // separately — not fixed by this check).
    const packagesByDir = {
      cli: {
        name: '@skillsmith/cli',
        version: '0.8.2',
        peerDependencies: { '@smith-horn/enterprise': '*' },
        peerDependenciesMeta: { '@smith-horn/enterprise': { optional: true } },
      },
      enterprise: { name: '@smith-horn/enterprise', version: '0.3.2' },
    }

    expect(() => evaluateInternalVersionCoherence(packagesByDir)).not.toThrow()

    const results = evaluateInternalVersionCoherence(packagesByDir)

    expect(results).toEqual([
      {
        dir: 'cli',
        section: 'peerDependencies',
        depName: '@smith-horn/enterprise',
        range: '*',
        status: 'dangling',
      },
    ])
  })

  it('checks a stale optional peer dependency with the same fail() severity as a required dep', () => {
    const packagesByDir = {
      'mcp-server': { name: '@skillsmith/mcp-server', version: '0.7.4' },
      enterprise: {
        name: '@smith-horn/enterprise',
        version: '0.3.2',
        peerDependencies: { '@skillsmith/mcp-server': '^0.5.0' },
        peerDependenciesMeta: { '@skillsmith/mcp-server': { optional: true } },
      },
    }

    const results = evaluateInternalVersionCoherence(packagesByDir)

    expect(results).toEqual([
      {
        dir: 'enterprise',
        section: 'peerDependencies',
        depName: '@skillsmith/mcp-server',
        range: '^0.5.0',
        actualVersion: '0.7.4',
        status: 'violation',
      },
    ])
  })

  it('passes clean on a healthy tree — all sections, all satisfied, one known dangling warn', () => {
    // Matches this repo's actual current packages/* shape (post SMI-5715
    // Change #1): doc-retrieval-mcp and skillsmith-cli's stale pins fixed,
    // packages/cli's dangling @smith-horn/enterprise peer dep left as-is
    // (SMI-5720, out of scope here).
    const packagesByDir = {
      core: { name: '@skillsmith/core', version: '0.11.2' },
      'mcp-server': {
        name: '@skillsmith/mcp-server',
        version: '0.7.4',
        dependencies: { '@skillsmith/core': '^0.11.2' },
      },
      cli: {
        name: '@skillsmith/cli',
        version: '0.8.2',
        devDependencies: {
          '@skillsmith/core': '^0.11.2',
          '@skillsmith/mcp-server': '^0.7.4',
        },
        peerDependencies: { '@smith-horn/enterprise': '*' },
        peerDependenciesMeta: { '@smith-horn/enterprise': { optional: true } },
      },
      enterprise: {
        name: '@smith-horn/enterprise',
        version: '0.3.2',
        dependencies: { '@skillsmith/core': '^0.11.2' },
        devDependencies: { '@skillsmith/mcp-server': '^0.7.4' },
        peerDependencies: { '@skillsmith/mcp-server': '^0.7.4' },
        peerDependenciesMeta: { '@skillsmith/mcp-server': { optional: true } },
      },
      'doc-retrieval-mcp': {
        name: '@skillsmith/doc-retrieval-mcp',
        version: '0.0.1',
        dependencies: { '@skillsmith/core': '^0.11.2' },
      },
      'skillsmith-cli': {
        name: 'skillsmith-cli',
        version: '0.5.3',
        dependencies: { '@skillsmith/cli': '^0.8.2' },
      },
    }

    const results = evaluateInternalVersionCoherence(packagesByDir)

    expect(results.filter((r: { status: string }) => r.status === 'violation')).toEqual([])
    expect(results.filter((r: { status: string }) => r.status === 'dangling')).toHaveLength(1)
    expect(
      results.filter((r: { status: string }) => r.status === 'ok').length
    ).toBeGreaterThanOrEqual(8)
  })
})

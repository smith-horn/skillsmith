/**
 * SMI-5123: POSITIVE-COVERAGE assertion for publish.yml dependency gating.
 *
 * `auditPublishYmlDependentGate` (tested in audit-standards.test.ts) only checks
 * that gates which EXIST are sound. `auditPublishYmlRequiredGates` checks that
 * REQUIRED gates are not MISSING — the SMI-5123 bug, where publish-cli depended
 * on @skillsmith/mcp-server in package.json but had no gate on
 * publish-mcp-server, so cli could publish a live dangling ref while mcp-server
 * was skipped (cli@0.6.3 → mcp-server@^0.5.3 that didn't exist).
 *
 * Split into its own file (not appended to audit-standards.test.ts) because that
 * file is already at the 500-line ceiling.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  auditPublishYmlRequiredGates: (
    content: string,
    pkgJsons: Array<{ name: string; json: { dependencies?: Record<string, string> } }>
  ) => {
    required: Array<{ consumer: string; sibling: string; outputKey: string }>
    failures: Array<{ consumer: string; sibling: string; outputKey: string; reason: string }>
  }
}

const { auditPublishYmlRequiredGates } = helpers

describe('auditPublishYmlRequiredGates (SMI-5123)', () => {
  // A correctly-gated cli job: needs: publish-mcp-server AND carries the
  // SMI-5060 paired predicate (mcp-exists output key per the alias map).
  const goodCliJob = [
    'jobs:',
    '  publish-cli:',
    '    needs: [pre-publish-check, validate, publish-core, publish-mcp-server]',
    '    if: |',
    "      (needs.publish-core.result == 'success' ||",
    "       (needs.publish-core.result == 'skipped' && needs.pre-publish-check.outputs.core-exists == 'true')) &&",
    "      (needs.publish-mcp-server.result == 'success' ||",
    "       (needs.publish-mcp-server.result == 'skipped' && needs.pre-publish-check.outputs.mcp-exists == 'true'))",
    '  publish-mcp-server:',
    '    needs: [pre-publish-check, validate, publish-core]',
  ].join('\n')

  const cliPkgs = [
    { name: '@skillsmith/cli', json: { dependencies: { '@skillsmith/mcp-server': '^0.5.3' } } },
    { name: '@skillsmith/mcp-server', json: { dependencies: {} } },
  ]

  it('passes when the cli→mcp gate is present (needs: + paired predicate)', () => {
    const { required, failures } = auditPublishYmlRequiredGates(goodCliJob, cliPkgs)
    expect(required).toHaveLength(1)
    expect(required[0]).toMatchObject({ consumer: 'cli', sibling: 'mcp-server', outputKey: 'mcp' })
    expect(failures).toHaveLength(0)
  })

  it('fails when the cli→mcp gate is missing entirely', () => {
    // publish-cli only gates on core — the SMI-5123 regression shape.
    const missingGate = [
      'jobs:',
      '  publish-cli:',
      '    needs: [pre-publish-check, validate, publish-core]',
      '    if: |',
      "      (needs.publish-core.result == 'success' ||",
      "       (needs.publish-core.result == 'skipped' && needs.pre-publish-check.outputs.core-exists == 'true'))",
      '  publish-mcp-server:',
      '    needs: [pre-publish-check, validate, publish-core]',
    ].join('\n')
    const { failures } = auditPublishYmlRequiredGates(missingGate, cliPkgs)
    // Two distinct failures: missing needs:, and missing paired predicate.
    expect(failures.length).toBeGreaterThanOrEqual(1)
    expect(failures.every((f) => f.consumer === 'cli' && f.sibling === 'mcp-server')).toBe(true)
  })

  it('ignores deps on non-publishable workspace packages', () => {
    // A dep that isn't itself in the publishable set must not require a gate.
    const pkgs = [
      { name: '@skillsmith/cli', json: { dependencies: { '@skillsmith/internal-lib': '^1.0.0' } } },
    ]
    const { required, failures } = auditPublishYmlRequiredGates(goodCliJob, pkgs)
    expect(required).toHaveLength(0)
    expect(failures).toHaveLength(0)
  })

  it('passes against the REAL publish.yml + real publishable package.json files', () => {
    const repoRoot = join(__dirname, '..', '..')
    const publishYml = readFileSync(join(repoRoot, '.github/workflows/publish.yml'), 'utf8')

    const publishableNames: string[] = JSON.parse(
      (publishYml.match(/PUBLISHABLE_PACKAGES_JSON:\s*'(\[[^']*\])'/) || [])[1] || '[]'
    )
    expect(publishableNames.length).toBeGreaterThan(0)

    const pkgJsons = publishableNames
      .map((name) => {
        const short = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
        const p = join(repoRoot, `packages/${short}/package.json`)
        return { name, json: JSON.parse(readFileSync(p, 'utf8')) }
      })
      .filter((x) => x.json)

    const { required, failures } = auditPublishYmlRequiredGates(publishYml, pkgJsons)
    // cli→core, cli→mcp-server, mcp-server→core, enterprise→core all required.
    expect(required.length).toBeGreaterThanOrEqual(1)
    expect(failures).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'

import { getReleasingVersions, runAudit } from '../verify-publish-deps.mjs'

/**
 * Build a `readJson` stub that returns package.json shapes keyed by path
 * suffix. `core` is the dependency; `mcp-server` declares the caret range.
 *
 * SMI-5672: `@smith-horn/enterprise`/`packages/enterprise/package.json` was
 * added to `PACKAGES` (it publishes to GitHub Packages, not npmjs — see
 * `registry` on its PACKAGES entry), and `runAudit`'s loop calls `readJson`
 * for every package whose file exists on disk with no skip — so every
 * existing test's `runAudit` call now also runs the sibling-dep Checks
 * against this enterprise fixture. Giving it an empty `dependencies` (zero
 * workspace deps to walk) is the safest fixture here: a fabricated
 * `@skillsmith/core` range on enterprise would re-run the exact same
 * Check 2/Check 3 evaluation the mcp-server fixture already runs for that
 * scenario, and in the "not yet on npm, not accepted" scenarios (e.g. the
 * `errors === 1` cases below) that duplicate evaluation would silently add a
 * SECOND error and break the exact-count assertions. Empty deps still
 * exercises the new PACKAGES entry (readJson is called, existsSync branch is
 * taken, the loop doesn't throw) without perturbing any existing scenario;
 * the enterprise-specific registry behavior gets its own dedicated test below
 * instead of being folded into this shared fixture.
 */
function makeReadJson(coreVersion: string, mcpDepRange: string) {
  return (p: string) => {
    if (p.endsWith('packages/core/package.json')) {
      return { name: '@skillsmith/core', version: coreVersion, dependencies: {} }
    }
    if (p.endsWith('packages/mcp-server/package.json')) {
      return {
        name: '@skillsmith/mcp-server',
        version: '0.6.2',
        dependencies: { '@skillsmith/core': mcpDepRange },
      }
    }
    if (p.endsWith('packages/cli/package.json')) {
      return { name: '@skillsmith/cli', version: '0.6.2', dependencies: {} }
    }
    if (p.endsWith('packages/enterprise/package.json')) {
      return { name: '@smith-horn/enterprise', version: '0.3.1', dependencies: {} }
    }
    throw new Error(`unexpected path: ${p}`)
  }
}

function makeLogger() {
  const lines: string[] = []
  return {
    lines,
    log: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  }
}

describe('runAudit — Check 3 in-PR version acceptance (SMI-4920)', () => {
  it('accepts an in-PR-released version that is not yet on npm', () => {
    const logger = makeLogger()
    const { errors } = runAudit({
      readJson: makeReadJson('0.6.2', '^0.6.2'),
      npmView: () => '', // 0.6.2 not on npm yet
      releasing: { versions: { '@skillsmith/core': '0.6.2' }, resolved: true },
      logger,
    })

    expect(errors).toBe(0)
    expect(logger.lines.join('\n')).toContain(
      '@skillsmith/core@0.6.2 — not yet on npm, accepted (released in this PR)'
    )
  })

  it('still rejects an unrelated unpublished pin (not in this PR)', () => {
    const logger = makeLogger()
    const { errors } = runAudit({
      // Working tree matches base: core 0.6.2, dep declares ^0.6.2.
      readJson: makeReadJson('0.6.2', '^0.6.2'),
      npmView: () => '', // 0.6.2 not on npm
      releasing: { versions: {}, resolved: true }, // non-release PR
      logger,
    })

    expect(errors).toBe(1)
    expect(logger.lines.join('\n')).toContain('is not published on npm')
  })

  it('base-resolution fallback: warns and falls back to npm-only Check 3', () => {
    const logger = makeLogger()
    const { errors } = runAudit({
      readJson: makeReadJson('0.6.2', '^0.6.2'),
      npmView: () => '0.6.2', // npm has it — npm-only check passes
      releasing: { versions: {}, resolved: false }, // base could not be resolved
      logger,
    })

    expect(errors).toBe(0)
    expect(logger.lines.join('\n')).toContain('could not resolve PR base ref')
  })

  it('passes cleanly when the declared version is published on npm', () => {
    const logger = makeLogger()
    const { errors } = runAudit({
      readJson: makeReadJson('0.6.2', '^0.6.2'),
      npmView: () => '0.6.2',
      releasing: { versions: {}, resolved: true },
      logger,
    })

    expect(errors).toBe(0)
  })

  it('does not accept an in-PR map entry whose version differs from the declared range', () => {
    const logger = makeLogger()
    const { errors } = runAudit({
      // dep declares ^0.6.2 (matches local), but the PR releases a different
      // core version — Check 3 must not silently accept the 0.6.2 pin.
      readJson: makeReadJson('0.6.2', '^0.6.2'),
      npmView: () => '',
      releasing: { versions: { '@skillsmith/core': '0.6.3' }, resolved: true },
      logger,
    })

    expect(errors).toBe(1)
    expect(logger.lines.join('\n')).toContain('is not published on npm')
  })
})

describe('getReleasingVersions — SMI-5077 unpublished-on-main acceptance', () => {
  /**
   * Simulates the SMI-5077 scenario: a prior PR bumped core@0.8.0 on main but
   * never published. HEAD-vs-base shows no diff for core, but core@0.8.0 is
   * unpublished on npm — getReleasingVersions must still mark it as
   * release-in-progress so consumers can caret-pin to it.
   */
  it('marks a same-on-base local version as releasing when unpublished on npm', () => {
    const local = {
      '@skillsmith/core': '0.8.0',
      '@skillsmith/mcp-server': '0.5.3',
      '@skillsmith/cli': '0.6.3',
    }
    const base = {
      // core was bumped on main but not published
      '@skillsmith/core': '0.8.0',
      // mcp-server and cli bumped on this PR
      '@skillsmith/mcp-server': '0.5.2',
      '@skillsmith/cli': '0.6.2',
    }
    const onNpm = new Set([
      // core 0.7.2 is the last published; 0.8.0 is unpublished
      '@skillsmith/core@0.7.2',
      '@skillsmith/mcp-server@0.5.2',
      '@skillsmith/cli@0.6.2',
    ])

    const result = getReleasingVersions({
      git: (args: string[]) => {
        if (args[0] === 'rev-parse') return 'abc123\n'
        if (args[0] === 'fetch') return ''
        if (args[0] === 'show') {
          // args[2] = "origin/main:packages/<dir>/package.json"
          const ref = args[1] as string
          const dir = ref.split(':')[1].replace('packages/', '').replace('/package.json', '')
          const pkgName =
            dir === 'core'
              ? '@skillsmith/core'
              : dir === 'mcp-server'
                ? '@skillsmith/mcp-server'
                : dir === 'cli'
                  ? '@skillsmith/cli'
                  : null
          if (!pkgName || !base[pkgName as keyof typeof base]) {
            throw new Error('not found')
          }
          return JSON.stringify({ name: pkgName, version: base[pkgName as keyof typeof base] })
        }
        return ''
      },
      readJson: (p: string) => {
        for (const [name, v] of Object.entries(local)) {
          const dir = name.split('/')[1]
          if (p.endsWith(`packages/${dir}/package.json`)) {
            return { name, version: v }
          }
        }
        return {}
      },
      npmView: (name: string, version: string) => (onNpm.has(`${name}@${version}`) ? version : ''),
    })

    expect(result.resolved).toBe(true)
    // All three should be marked as releasing — the two with diff (mcp-server,
    // cli) and the one with unpublished local-equals-base (core).
    expect(result.versions).toMatchObject({
      '@skillsmith/core': '0.8.0',
      '@skillsmith/mcp-server': '0.5.3',
      '@skillsmith/cli': '0.6.3',
    })
  })

  it('does NOT mark a same-on-base local version as releasing when it IS published', () => {
    const result = getReleasingVersions({
      git: (args: string[]) => {
        if (args[0] === 'rev-parse') return 'abc123\n'
        if (args[0] === 'show') {
          return JSON.stringify({ name: '@skillsmith/core', version: '0.7.2' })
        }
        return ''
      },
      readJson: () => ({ name: '@skillsmith/core', version: '0.7.2' }),
      npmView: () => '0.7.2', // every version is on npm
    })

    expect(result.resolved).toBe(true)
    expect(result.versions).toEqual({})
  })
})

describe('getReleasingVersions — SMI-5672 registry-aware enterprise lookups', () => {
  /**
   * @smith-horn/enterprise publishes to GitHub Packages, not npmjs. The
   * SMI-5077 "unpublished on npm" fallback check (`npmView(pkg.name,
   * localVersion, pkg.registry)`) must probe enterprise's OWN published
   * version on its OWN registry — passing no registry (npmjs default) would
   * 404 unconditionally and misclassify every enterprise release as
   * "unpublished". Every other package's registry stays undefined (npmjs).
   */
  it('calls npmView with the GitHub Packages registry for @smith-horn/enterprise, and no registry for the npmjs packages', () => {
    const local = {
      '@skillsmith/core': '0.7.2',
      '@skillsmith/mcp-server': '0.5.2',
      '@skillsmith/cli': '0.6.2',
      '@smith-horn/enterprise': '0.3.1',
    }
    // Every package is unchanged from base — forces every package through the
    // SMI-5077 "still unpublished?" npmView branch, so each npmView call is
    // observable regardless of the HEAD-vs-base diff.
    const calls: Array<{ name: string; version: string; registry?: string }> = []

    const result = getReleasingVersions({
      git: (args: string[]) => {
        if (args[0] === 'rev-parse') return 'abc123\n'
        if (args[0] === 'show') {
          const ref = args[1] as string
          const dir = ref.split(':')[1].replace('packages/', '').replace('/package.json', '')
          const entry = Object.entries(local).find(([name]) => name.split('/')[1] === dir)
          if (!entry) throw new Error('not found')
          return JSON.stringify({ name: entry[0], version: entry[1] })
        }
        return ''
      },
      readJson: (p: string) => {
        for (const [name, v] of Object.entries(local)) {
          const dir = name.split('/')[1]
          if (p.endsWith(`packages/${dir}/package.json`)) {
            return { name, version: v }
          }
        }
        return {}
      },
      npmView: (name: string, version: string, registry?: string) => {
        calls.push({ name, version, registry })
        // Treat everything as already published — isolates this test to the
        // registry-routing assertion rather than the "mark as releasing" logic.
        return version
      },
    })

    expect(result.resolved).toBe(true)
    expect(result.versions).toEqual({})

    const enterpriseCall = calls.find((c) => c.name === '@smith-horn/enterprise')
    expect(enterpriseCall).toBeDefined()
    expect(enterpriseCall?.registry).toBe('https://npm.pkg.github.com')

    for (const npmjsName of ['@skillsmith/core', '@skillsmith/mcp-server', '@skillsmith/cli']) {
      const call = calls.find((c) => c.name === npmjsName)
      expect(call).toBeDefined()
      expect(call?.registry).toBeUndefined()
    }
  })
})

describe('runAudit — SMI-5672 registry-aware Check 3 for enterprise dependencies', () => {
  /**
   * Even though @smith-horn/enterprise itself is published on GitHub
   * Packages, its dependency on @skillsmith/core must still be verified on
   * npmjs (core's own registry) — Check 3 resolves the registry from the
   * DEPENDENCY's PACKAGES entry (`sibling.registry`), not the consuming
   * package's registry.
   */
  it("checks enterprise's @skillsmith/core dependency on npmjs, not on enterprise's GitHub Packages registry", () => {
    const calls: Array<{ name: string; version: string; registry?: string }> = []
    const readJson = (p: string) => {
      if (p.endsWith('packages/core/package.json')) {
        return { name: '@skillsmith/core', version: '0.6.2', dependencies: {} }
      }
      if (p.endsWith('packages/mcp-server/package.json')) {
        return { name: '@skillsmith/mcp-server', version: '0.6.2', dependencies: {} }
      }
      if (p.endsWith('packages/cli/package.json')) {
        return { name: '@skillsmith/cli', version: '0.6.2', dependencies: {} }
      }
      if (p.endsWith('packages/enterprise/package.json')) {
        return {
          name: '@smith-horn/enterprise',
          version: '0.3.1',
          dependencies: { '@skillsmith/core': '^0.6.2' },
        }
      }
      throw new Error(`unexpected path: ${p}`)
    }
    const logger = makeLogger()

    const { errors } = runAudit({
      readJson,
      npmView: (name: string, version: string, registry?: string) => {
        calls.push({ name, version, registry })
        return version // treat as published everywhere — isolates the registry-routing assertion
      },
      releasing: { versions: {}, resolved: true },
      logger,
    })

    expect(errors).toBe(0)

    const coreDepLookup = calls.find((c) => c.name === '@skillsmith/core' && c.version === '0.6.2')
    expect(coreDepLookup).toBeDefined()
    expect(coreDepLookup?.registry).toBeUndefined()
  })
})

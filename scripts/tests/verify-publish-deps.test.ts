import { describe, expect, it } from 'vitest'

import { getReleasingVersions, runAudit } from '../verify-publish-deps.mjs'

/**
 * Build a `readJson` stub that returns package.json shapes keyed by path
 * suffix. `core` is the dependency; `mcp-server` declares the caret range.
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

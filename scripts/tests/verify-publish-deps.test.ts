import { describe, expect, it } from 'vitest'

import { runAudit } from '../verify-publish-deps.mjs'

/**
 * Build a `readJson` stub that returns package.json shapes keyed by path
 * suffix. `core` is the dependency; `mcp-server` declares the caret range.
 */
function makeReadJson(coreVersion: string, mcpDepRange: string) {
  return (p: string) => {
    if (p.endsWith('packages/core/package.json')) {
      return { name: '@skillsmith/core', version: coreVersion, dependencies: {} }
    }
    // SMI-5066: billing-types added to PACKAGES. No deps to inspect (types-only
    // contract). Test fixture mirrors that — empty dependencies, fixed version.
    if (p.endsWith('packages/billing-types/package.json')) {
      return { name: '@skillsmith/billing-types', version: '0.1.0', dependencies: {} }
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

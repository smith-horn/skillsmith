/**
 * Unit tests for smoke-test-published helper functions.
 * SMI-4923: verify buildCliSmokeCommand produces the correct npx form for
 * multi-bin packages (explicit -p <pkg>@<version> <bin> instead of bare
 * `npx -y <pkg>@<version>` which fails when no bin matches the package-name
 * segment).
 */

import { describe, it, expect } from 'vitest'
import { buildCliSmokeCommand } from '../smoke-test-published'

describe('buildCliSmokeCommand', () => {
  it('returns correct npx command for the skillsmith bin', () => {
    expect(buildCliSmokeCommand('@skillsmith/cli', '1.2.3', 'skillsmith')).toBe(
      'npx -y -p @skillsmith/cli@1.2.3 skillsmith --help'
    )
  })

  it('returns correct npx command for the sklx bin', () => {
    expect(buildCliSmokeCommand('@skillsmith/cli', '1.2.3', 'sklx')).toBe(
      'npx -y -p @skillsmith/cli@1.2.3 sklx --help'
    )
  })
})

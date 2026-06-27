/**
 * Unit tests for smoke-test-published helper functions.
 * SMI-5414: verify buildCliBinSmokeCommand produces the LOCAL-bin command
 * (`<tempDir>/node_modules/.bin/<bin> --help`) — the CLI smoke runs each bin
 * from test 1's local install instead of `npx -y -p <pkg>@<ver> <bin>`, which
 * races the npx cache on Ubuntu CI runners (was the SMI-4923 multi-bin npx
 * form; the bin link was intermittently absent → false "<bin>: not found").
 */

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { buildCliBinSmokeCommand } from '../smoke-test-published'

describe('buildCliBinSmokeCommand', () => {
  it('returns the local-bin command for the skillsmith bin', () => {
    expect(buildCliBinSmokeCommand('/tmp/x', 'skillsmith')).toBe(
      `${join('/tmp/x', 'node_modules', '.bin', 'skillsmith')} --help`
    )
  })

  it('returns the local-bin command for the sklx bin', () => {
    expect(buildCliBinSmokeCommand('/tmp/x', 'sklx')).toBe(
      `${join('/tmp/x', 'node_modules', '.bin', 'sklx')} --help`
    )
  })
})

/**
 * SMI-4533: Tests for scripts/lib/forbid-local-publish.mjs.
 *
 * Pin the contract that `prepublishOnly` refuses local invocations and
 * accepts only well-formed `SKILLSMITH_PUBLISH_OVERRIDE` values. Process-exit
 * is mocked so failures don't tear down the test runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendFileSync } from 'node:fs'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, appendFileSync: vi.fn() }
})

import { assertCiPublishContext } from '../lib/forbid-local-publish.mjs'

const mockedAppend = vi.mocked(appendFileSync)

describe('assertCiPublishContext (SMI-4533)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockedAppend.mockClear()
    exitSpy = vi
      .spyOn(process, 'exit')
      // Throw so call sites short-circuit instead of exiting the test runner.
      .mockImplementation(((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code ?? 'undefined'})`)
      }) as never)
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    exitSpy.mockRestore()
    errSpy.mockRestore()
  })

  // --- CI path (the happy path) ---

  it('returns silently inside canonical-repo GitHub Actions runner', () => {
    expect(() =>
      assertCiPublishContext({
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'smith-horn/skillsmith',
      })
    ).not.toThrow()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(mockedAppend).not.toHaveBeenCalled()
  })

  it('refuses when CI=false (local maintainer laptop)', () => {
    expect(() => assertCiPublishContext({})).toThrow('process.exit(1)')
    expect(errSpy).toHaveBeenCalled()
    const allOutput = errSpy.mock.calls.flat().join(' ')
    expect(allOutput).toContain('SMI-4533')
    expect(allOutput).toContain('publish.yml')
    expect(allOutput).toContain('docs/internal/runbooks/publish-ci-recovery.md')
  })

  it('refuses when CI=true but not canonical repo (forks publishing their own packages)', () => {
    expect(() =>
      assertCiPublishContext({
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'someone-else/their-fork',
      })
    ).toThrow('process.exit(1)')
  })

  it('refuses when GITHUB_ACTIONS missing (other CI providers)', () => {
    expect(() =>
      assertCiPublishContext({
        CI: 'true',
        GITHUB_REPOSITORY: 'smith-horn/skillsmith',
      })
    ).toThrow('process.exit(1)')
  })

  // --- Override path ---

  it('accepts a valid override (SMI-NNNN + ≥20 chars after prefix) and appends to the audit log', () => {
    expect(() =>
      assertCiPublishContext({
        SKILLSMITH_PUBLISH_OVERRIDE: 'SMI-4499 emergency hotfix for prod incident',
        HOME: '/home/test',
      })
    ).not.toThrow()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(mockedAppend).toHaveBeenCalledTimes(1)
    const [path, line] = mockedAppend.mock.calls[0]!
    expect(path).toBe('/home/test/.skillsmith-publish-overrides.log')
    expect(line).toContain('SMI-4499 emergency hotfix for prod incident')
    expect(line).toContain('local')
    // Line should end with a newline.
    expect(String(line).endsWith('\n')).toBe(true)
  })

  it('records GITHUB_REPOSITORY in the audit log when present', () => {
    expect(() =>
      assertCiPublishContext({
        SKILLSMITH_PUBLISH_OVERRIDE: 'SMI-4499 emergency hotfix for prod incident',
        HOME: '/home/test',
        GITHUB_REPOSITORY: 'smith-horn/skillsmith',
      })
    ).not.toThrow()
    const [, line] = mockedAppend.mock.calls[0]!
    expect(line).toContain('smith-horn/skillsmith')
  })

  it('refuses an override missing the SMI- prefix', () => {
    expect(() =>
      assertCiPublishContext({
        SKILLSMITH_PUBLISH_OVERRIDE: 'just because the build is broken right now',
      })
    ).toThrow('process.exit(1)')
    const allOutput = errSpy.mock.calls.flat().join(' ')
    expect(allOutput).toContain('format invalid')
    expect(allOutput).toContain('SMI-NNNN')
    expect(mockedAppend).not.toHaveBeenCalled()
  })

  it('refuses an override that is too short (rationale under 20 chars after the SMI prefix)', () => {
    expect(() =>
      assertCiPublishContext({
        SKILLSMITH_PUBLISH_OVERRIDE: 'SMI-1 short',
      })
    ).toThrow('process.exit(1)')
    expect(mockedAppend).not.toHaveBeenCalled()
  })

  it('refuses OVERRIDE=1 specifically (the documented anti-pattern)', () => {
    expect(() =>
      assertCiPublishContext({
        SKILLSMITH_PUBLISH_OVERRIDE: '1',
      })
    ).toThrow('process.exit(1)')
  })

  it('still permits the override when CI signals are absent (the whole point of break-glass)', () => {
    // Local laptop, no CI env — but with a valid override.
    expect(() =>
      assertCiPublishContext({
        SKILLSMITH_PUBLISH_OVERRIDE: 'SMI-4499 emergency hotfix for prod incident',
        HOME: '/home/test',
      })
    ).not.toThrow()
    expect(mockedAppend).toHaveBeenCalledTimes(1)
  })

  it('falls back to /tmp when HOME is unset (audit log still attempted)', () => {
    expect(() =>
      assertCiPublishContext({
        SKILLSMITH_PUBLISH_OVERRIDE: 'SMI-4499 emergency hotfix for prod incident',
      })
    ).not.toThrow()
    const [path] = mockedAppend.mock.calls[0]!
    expect(path).toBe('/tmp/.skillsmith-publish-overrides.log')
  })
})

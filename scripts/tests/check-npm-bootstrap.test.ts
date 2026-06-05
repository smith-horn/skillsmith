/**
 * SMI-5122: tests for the pre-publish bootstrap fail-fast helper
 * (scripts/check-npm-bootstrap.mjs).
 *
 * `classifyNpmExistence` is the load-bearing pure function: it decides whether
 * a publish should be blocked (a package that genuinely has zero versions on
 * npm cannot be bootstrapped by OIDC trusted-publishing) or allowed to proceed
 * (the registry was simply unreachable). Getting the second case wrong would
 * block every release on a flaky registry, so the four branches below are the
 * core invariant.
 *
 * Dynamic ESM import — same convention as audit-standards.test.ts and
 * check-supply-chain-pins.test.ts (the module is .mjs, no .ts transpilation).
 */
import { describe, expect, it } from 'vitest'

const mod = (await import('../check-npm-bootstrap.mjs')) as {
  classifyNpmExistence: (io: { stdout?: string; stderr?: string }) => string
  bootstrapErrorMessage: (pkg: string) => string
  checkNpmExistence: (pkg: string, deps?: { exec?: (...args: unknown[]) => string }) => string
}

const { classifyNpmExistence, bootstrapErrorMessage, checkNpmExistence } = mod

describe('classifyNpmExistence (SMI-5122)', () => {
  it("returns 'exists' when stdout is a non-empty version string", () => {
    expect(classifyNpmExistence({ stdout: '1.2.3\n', stderr: '' })).toBe('exists')
  })

  it("returns 'missing' on an E404 / not-found stderr with empty stdout", () => {
    expect(
      classifyNpmExistence({
        stdout: '',
        stderr:
          'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@skillsmith%2fnope',
      })
    ).toBe('missing')
    // "is not in this registry" phrasing (GitHub Packages / older npm)
    expect(classifyNpmExistence({ stdout: '', stderr: '@x/y is not in this registry.' })).toBe(
      'missing'
    )
  })

  it("returns 'network-error' on a transient network/registry stderr", () => {
    expect(
      classifyNpmExistence({
        stdout: '',
        stderr:
          'npm error code EAI_AGAIN\nnpm error errno EAI_AGAIN\nrequest to https://registry.npmjs.org failed, reason: getaddrinfo EAI_AGAIN',
      })
    ).toBe('network-error')
    expect(classifyNpmExistence({ stdout: '', stderr: 'unable to access the registry' })).toBe(
      'network-error'
    )
    expect(classifyNpmExistence({ stdout: '', stderr: 'certificate verification failed' })).toBe(
      'network-error'
    )
  })

  it("returns 'network-error' (fail open) on empty stdout with no recognizable signal", () => {
    // Conservative: never block a publish on an ambiguous/blank response.
    expect(classifyNpmExistence({ stdout: '', stderr: '' })).toBe('network-error')
    expect(classifyNpmExistence({ stdout: '   ', stderr: 'some unrecognized message' })).toBe(
      'network-error'
    )
    expect(classifyNpmExistence({})).toBe('network-error')
  })
})

describe('bootstrapErrorMessage (SMI-5122)', () => {
  it('names the package and the two registries plus the npmjs.com remedy', () => {
    const msg = bootstrapErrorMessage('@skillsmith/new-pkg')
    expect(msg).toContain('@skillsmith/new-pkg')
    expect(msg).toContain('PUBLISHABLE_PACKAGES_JSON')
    expect(msg).toContain('PACKAGE_SPECS')
    expect(msg).toContain('Trusted Publisher')
    expect(msg).toContain('publishing-guide.md')
  })
})

describe('checkNpmExistence (SMI-5122)', () => {
  it("maps a successful npm view to 'exists'", () => {
    const exec = () => '1.0.0\n'
    expect(checkNpmExistence('@skillsmith/core', { exec: exec as never })).toBe('exists')
  })

  it("reads stderr off the thrown error for the 404 path → 'missing'", () => {
    const exec = () => {
      const err = new Error('Command failed') as Error & { stdout?: string; stderr?: string }
      err.stdout = ''
      err.stderr = 'npm error 404 Not Found'
      throw err
    }
    expect(checkNpmExistence('@skillsmith/nope', { exec: exec as never })).toBe('missing')
  })

  it("reads stderr off the thrown error for the network path → 'network-error'", () => {
    const exec = () => {
      const err = new Error('Command failed') as Error & { stdout?: string; stderr?: string }
      err.stdout = ''
      err.stderr = 'getaddrinfo ENOTFOUND registry.npmjs.org'
      throw err
    }
    expect(checkNpmExistence('@skillsmith/core', { exec: exec as never })).toBe('network-error')
  })
})

/**
 * @fileoverview licenseKeyFingerprint()'s credential source (SMI-6622 round 2)
 * @see SMI-6622: `licenseKeyFingerprint()` (registry-tools.live.audit.ts) previously read only
 *      `team-resolver.ts`'s env-only `readLicenseKey()`, so a caller authenticated purely via
 *      `~/.skillsmith/config.json`'s `apiKey` (no env var set at all — a real, supported credential
 *      source for `registry-tools.team.ts`'s team resolution) fingerprinted as `null`/absent even
 *      though a real credential authorized the operation. Fixed by reading the same
 *      `readRegistryCredential()` team resolution itself uses.
 *
 * Deliberately its own small file, not appended to registry-tools.live.audit.ts's future test
 * coverage — a parallel SMI-6114 branch is moving mutation audits server-side and edits that
 * source file; a separate test file here has no lines in common with whatever it adds.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { licenseKeyFingerprint } from './registry-tools.live.audit.js'

function configPath(): string {
  return join(homedir(), '.skillsmith', 'config.json')
}

function writeConfigApiKey(apiKey: string): void {
  mkdirSync(join(homedir(), '.skillsmith'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify({ apiKey }), 'utf-8')
}

describe('licenseKeyFingerprint() — credential source (SMI-6622 round 2)', () => {
  const origLicense = process.env.SKILLSMITH_LICENSE_KEY
  const origApiKey = process.env.SKILLSMITH_API_KEY

  afterEach(() => {
    if (origLicense === undefined) delete process.env.SKILLSMITH_LICENSE_KEY
    else process.env.SKILLSMITH_LICENSE_KEY = origLicense
    if (origApiKey === undefined) delete process.env.SKILLSMITH_API_KEY
    else process.env.SKILLSMITH_API_KEY = origApiKey
    rmSync(configPath(), { force: true })
  })

  it('fingerprints a credential present ONLY in ~/.skillsmith/config.json, not just env', async () => {
    delete process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_API_KEY
    writeConfigApiKey('sk_live_fingerprint_from_config')

    const fingerprint = licenseKeyFingerprint()

    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(fingerprint).not.toContain('sk_live_fingerprint_from_config')
  })

  it('is a stable, deterministic hash of the SAME config-sourced credential across calls', async () => {
    delete process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_API_KEY
    writeConfigApiKey('sk_live_stable_check')

    expect(licenseKeyFingerprint()).toBe(licenseKeyFingerprint())
  })

  it('still fingerprints an env-sourced credential (regression: env path unchanged)', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_env_regression'

    const fingerprint = licenseKeyFingerprint()

    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/)
  })

  it('returns null when no credential exists anywhere — env or config.json', async () => {
    delete process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_API_KEY

    expect(licenseKeyFingerprint()).toBeNull()
  })
})

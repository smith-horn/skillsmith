/**
 * SMI-7056 contract test: the CLI confirmation helper against the REAL core gate.
 *
 * The CLI unit tests mock core's CONFIRMATION_REQUIRED result, and core's own
 * gate tests never run the CLI helper. This file joins the two: it drives the
 * real SkillInstallationService (imported from core source, not a possibly
 * stale dist) through installWithConfirmation, so a change to core's gate,
 * result shape or reason wording that the CLI no longer handles fails here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

import { SkillInstallationService } from '../../core/src/services/skill-installation.service.js'
import { SkillRepository } from '../../core/src/repositories/SkillRepository.js'
import { SkillDependencyRepository } from '../../core/src/repositories/SkillDependencyRepository.js'
import type { RegistryLookup } from '../../core/src/services/skill-installation.types.js'
import type { TrustTier } from '../../core/src/types/skill.js'
import { createTestDatabase } from '../../core/tests/helpers/database.js'
import type { Database } from '../../core/src/db/database-interface.js'
import { installWithConfirmation } from '../src/commands/install.confirm.js'

const VALID_SKILL_MD = `---
name: contract-skill
description: A skill used by the SMI-7056 CLI-to-core contract test
---

# Contract Skill

This is a valid skill file with enough content to pass the 100-character minimum
validation threshold that the service checks during installation.
`

describe('SMI-7056: CLI confirmation helper against the real core gate', () => {
  let db: Database
  let roots: string[] = []
  const ttyDescriptors = {
    stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
    stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
  }

  function serviceFor(tier: TrustTier): SkillInstallationService {
    const root = path.join(
      os.tmpdir(),
      'skillsmith-7056-contract-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    )
    roots.push(root)
    const lookup: RegistryLookup = {
      async lookup() {
        return {
          repoUrl: 'https://github.com/author/contract-skill',
          name: 'contract-skill',
          trustTier: tier,
        }
      },
    }
    return new SkillInstallationService({
      db,
      skillRepo: new SkillRepository(db),
      skillDependencyRepo: new SkillDependencyRepository(db),
      skillsDir: path.join(root, 'skills'),
      manifestPath: path.join(root, 'manifest.json'),
      registryLookup: lookup,
    })
  }

  beforeEach(async () => {
    db = await createTestDatabase()
    roots = []
    // Non-interactive: the helper must refuse rather than prompt.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) return new Response(VALID_SKILL_MD, { status: 200 })
      return new Response('Not found', { status: 404 })
    })
  })

  afterEach(async () => {
    db.close()
    vi.unstubAllGlobals()
    for (const [key, original] of Object.entries(ttyDescriptors)) {
      const stream = key === 'stdin' ? process.stdin : process.stdout
      if (original) Object.defineProperty(stream, 'isTTY', original)
      else delete (stream as { isTTY?: boolean }).isTTY
    }
    await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true }).catch(() => {})))
  })

  it('an unverified registry skill installs with --yes and is refused, naming --yes, without it', async () => {
    // Presence partner first: with --yes the real gate is answered and the install succeeds.
    const service = serviceFor('unverified')
    const confirmed = await installWithConfirmation(
      (o) => service.install('author/contract-skill', { skipOptimize: true, ...o }),
      {},
      { yes: true }
    )
    expect(confirmed.success).toBe(true)

    // Without --yes, on a non-TTY, core's CONFIRMATION_REQUIRED becomes a CLI refusal.
    const refused = await installWithConfirmation(
      (o) =>
        serviceFor('unverified').install('author/contract-skill', { skipOptimize: true, ...o }),
      {},
      {}
    )
    expect(refused.success).toBe(false)
    expect(refused.errorCode).toBe('CONFIRMATION_REQUIRED')
    expect(refused.error).toContain('--yes')
    // Core's API-flavoured "confirmed=true" wording never reaches a CLI user.
    expect(refused.error).not.toContain('confirmed=true')
    expect((refused.tips ?? []).join(' ')).not.toContain('confirmed=true')
  })

  it('--yes never lifts the skipScan refusal for a gated tier', async () => {
    const result = await installWithConfirmation(
      (o) =>
        serviceFor('unverified').install('author/contract-skill', {
          skipOptimize: true,
          skipScan: true,
          ...o,
        }),
      {},
      { yes: true }
    )
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('SKIP_SCAN_FORBIDDEN')
  })
})

/**
 * @fileoverview SMI-5905 Wave 5 — cross-transport round-trip: the FULL assembled path.
 * @see docs/internal/implementation/private-registry-skill-install.md (Wave 5)
 *
 * Plan review finding #9 moved every per-risk adversarial test (path traversal, cross-team,
 * downgraded-target-team, degraded-auth) into the wave that introduces the risk — Waves 1-3 ship
 * those already:
 *   - `packages/core/tests/unit/services/skill-installation.content.test.ts` (path-safety, Wave 1)
 *   - `supabase/functions/private-registry-get/index.test.ts` + `index.entitlement.test.ts` (auth,
 *     entitlement, 404/403 non-leak, `Cache-Control: no-store`, audit rows — Wave 2)
 *   - `registry-tools.live.content.test.ts` / `.adversarial-content.test.ts` /
 *     `.admin-auth.test.ts` / `.malformed-input.test.ts` (entitlement, client-getter split, audit
 *     rows — Wave 3)
 *   - `registry-tools.install-action.test.ts` (a genuine MCP publish(stub)->install->on-disk round
 *     trip, structural no-content-leak on `PrivateRegistryManageResult`, version selection — Wave 3)
 *   - `packages/cli/src/commands/registry-install.action*.test.ts` (command wiring, --client
 *     targeting, Edge Function error-code mapping, console-output non-leak — Wave 4, but with
 *     `getPrivateRegistrySkillContent()` and `installFromContent()` both mocked out)
 *
 * What none of the above cover, and what this file adds: the CLI transport exercised with its own
 * two REAL production functions wired together — `getPrivateRegistrySkillContent()`
 * (`client.private-registry.ts`, only `global.fetch` mocked, shaped exactly like the Wave 2 Edge
 * Function's documented response contract) feeding a REAL `SkillInstallationService.
 * installFromContent()` writing to a real temp directory — and then compared directly against the
 * MCP transport's own already-proven real round trip (`executeRegistryInstall`), against the SAME
 * underlying published data, to prove the two transports never disagree about which version "no
 * version specified" resolves to, or about what actually lands on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  SkillInstallationService,
  SkillRepository,
  SkillDependencyRepository,
  createDatabaseAsync,
  initializeSchema,
  getPrivateRegistrySkillContent,
  type Database,
  type PrivateRegistryGetResult,
  type CoreInstallResult,
} from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { executeRegistryInstall } from './registry-tools.install-action.js'
import { createStubRegistryService, type PrivateRegistryService } from './registry-tools.js'

const mockContext = {} as ToolContext
const TEAM = 'team-alpha'
const SKILL_ID = 'myteam/acme-tool'

/** A canary line — the "raw content must never leak" assertions grep for its absence. */
const SECRET_MARKER = 'a private team runbook line that must never leak into any surface'
/** Present only in the version published as `2.0.0` — the canary for a wrong-version pick. */
const V2_MARKER = 'content-that-only-the-2-0-0-release-carries'
/** Present only in the version published as `1.9.0` — the "most recently published" one below. */
const V1_9_MARKER = 'content-that-only-the-1-9-0-release-carries'

function skillMd(marker: string): string {
  return (
    `---\nname: acme-tool\ndescription: Cross-transport round-trip fixture for SMI-5905\n---\n\n` +
    `# Acme Tool\n\n${marker}. Long enough to clear the 100-character SKILL.md minimum ` +
    `enforced by the install path's frontmatter validation.\n`
  )
}

const ORIGINAL_FETCH = globalThis.fetch

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface Rig {
  db: Database
  skillsDir: string
  manifestPath: string
}

async function makeRig(label: string): Promise<Rig> {
  const db = await createDatabaseAsync(':memory:')
  initializeSchema(db)
  const tmpDir = path.join(
    os.tmpdir(),
    `skillsmith-registry-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  const skillsDir = path.join(tmpDir, 'skills')
  await fs.mkdir(skillsDir, { recursive: true })
  return { db, skillsDir, manifestPath: path.join(tmpDir, 'manifest.json') }
}

function installerFor(rig: Rig): SkillInstallationService {
  return new SkillInstallationService({
    db: rig.db,
    skillRepo: new SkillRepository(rig.db),
    skillDependencyRepo: new SkillDependencyRepository(rig.db),
    skillsDir: rig.skillsDir,
    manifestPath: rig.manifestPath,
  })
}

/** The MCP transport's own real round trip — reuses Wave 3's proven handler unmodified. */
function installViaMcp(service: PrivateRegistryService, rig: Rig, version?: string) {
  return executeRegistryInstall({
    input: { action: 'install', skillId: SKILL_ID, ...(version !== undefined && { version }) },
    teamId: TEAM,
    dataSource: 'stub',
    service,
    context: mockContext,
    createInstaller: () => installerFor(rig),
  })
}

/**
 * The CLI transport's own real round trip: real `getPrivateRegistrySkillContent()` parsing a
 * `global.fetch` response shaped exactly like the Wave 2 Edge Function's documented 200/404
 * contract (`supabase/functions/private-registry-get/index.ts` lines 231-243), then real
 * `installFromContent()`. `global.fetch` is the ONLY thing mocked — everything downstream of it
 * is production code, same as `registry-install.action.ts` calls in the real CLI.
 *
 * The mocked response is built from `service.getContent()` — the SAME call
 * `executeRegistryInstall()` makes on the MCP side — so both transports draw from one underlying
 * fact about what was published, and any disagreement in the result is a real wiring bug, not a
 * fixture mismatch.
 */
async function installViaCli(
  service: PrivateRegistryService,
  rig: Rig,
  version?: string
): Promise<{ fetchResult: PrivateRegistryGetResult; installResult: CoreInstallResult | null }> {
  const underlying = await service.getContent(TEAM, SKILL_ID, version)
  globalThis.fetch = (async () => {
    if (!underlying) return jsonResponse({ error: 'Skill not found' }, 404)
    return jsonResponse(
      {
        data: {
          skill_id: underlying.skillId,
          team_id: underlying.teamId,
          version: underlying.version,
          description: null,
          content_hash: underlying.contentHash,
          deprecated: underlying.deprecated,
          published_at: underlying.publishedAt,
          content: underlying.content,
        },
      },
      200
    )
  }) as unknown as typeof globalThis.fetch

  const fetchResult = await getPrivateRegistrySkillContent({
    jwtToken: 'fake-user-jwt',
    skillId: SKILL_ID,
    ...(version !== undefined && { version }),
  })
  if (!fetchResult.ok) return { fetchResult, installResult: null }

  const installResult = await installerFor(rig).installFromContent({
    skillId: fetchResult.data.skill_id,
    version: fetchResult.data.version,
    content: fetchResult.data.content,
  })
  return { fetchResult, installResult }
}

let service: PrivateRegistryService
let mcpRig: Rig
let cliRig: Rig

beforeEach(async () => {
  service = createStubRegistryService()
  mcpRig = await makeRig('mcp')
  cliRig = await makeRig('cli')
})

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH
  mcpRig.db.close()
  cliRig.db.close()
  await fs.rm(path.dirname(mcpRig.manifestPath), { recursive: true, force: true }).catch(() => {})
  await fs.rm(path.dirname(cliRig.manifestPath), { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------
// CLI transport — real client.private-registry.ts + real installFromContent()
// ---------------------------------------------------------------------------
describe('CLI transport — full publish -> install round trip (real client fn + real installer)', () => {
  it('installs published content to disk with private-registry provenance', async () => {
    await service.publish(TEAM, SKILL_ID, '1.0.0', { 'SKILL.md': skillMd(SECRET_MARKER) })

    const { fetchResult, installResult } = await installViaCli(service, cliRig)

    expect(fetchResult.ok).toBe(true)
    expect(installResult?.success).toBe(true)

    const installedSkillMd = await fs.readFile(
      path.join(cliRig.skillsDir, 'acme-tool', 'SKILL.md'),
      'utf-8'
    )
    expect(installedSkillMd).toContain(SECRET_MARKER)

    const manifest = JSON.parse(await fs.readFile(cliRig.manifestPath, 'utf-8'))
    expect(manifest.installedSkills['acme-tool'].source).toBe(`private-registry:${SKILL_ID}`)
    expect(manifest.installedSkills['acme-tool'].version).toBe('1.0.0')

    // Defense in depth beyond the MCP-side `PrivateRegistryManageResult` allowlist (already
    // proven structurally in registry-tools.install-action.test.ts): the CLI's own raw core
    // `InstallResult` — before `install.ts`'s `formatJsonResult()` allowlist ever narrows it —
    // must not carry the published bytes either.
    expect(JSON.stringify(installResult)).not.toContain(SECRET_MARKER)
  })

  it('a deprecated skill still installs via the install path itself, not just the metadata fetch', async () => {
    // Wave 2/3 already prove `getContent()`/the Edge Function still RETURN a deprecated row
    // (index.entitlement.test.ts, registry-tools.live.content.test.ts). This proves the
    // INSTALL step specifically does not add its own deprecation gate on top of that.
    await service.publish(TEAM, SKILL_ID, '1.0.0', { 'SKILL.md': skillMd(SECRET_MARKER) })
    await service.deprecate(TEAM, SKILL_ID)

    const { fetchResult, installResult } = await installViaCli(service, cliRig)

    expect(fetchResult.ok && fetchResult.data.deprecated).toBe(true)
    expect(installResult?.success).toBe(true)
    await expect(
      fs.access(path.join(cliRig.skillsDir, 'acme-tool', 'SKILL.md'))
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Cross-transport agreement — same underlying data, two independent real code paths
// ---------------------------------------------------------------------------
describe('MCP and CLI transports agree on version selection, given the same published data', () => {
  beforeEach(async () => {
    // Published out of semver order on purpose, mirroring registry-tools.install-action.test.ts's
    // established "most recently PUBLISHED wins, not highest semver" rule: 2.0.0 first, 1.9.0
    // second, so 1.9.0 is both the most-recent publish AND the lower version number. A
    // version-selection bug on either transport (e.g. picking highest-semver, or picking
    // first-published) would install the WRONG marker string here.
    await service.publish(TEAM, SKILL_ID, '2.0.0', { 'SKILL.md': skillMd(V2_MARKER) })
    await service.publish(TEAM, SKILL_ID, '1.9.0', { 'SKILL.md': skillMd(V1_9_MARKER) })
  })

  it('an omitted version resolves to the identical most-recently-published row on both transports', async () => {
    const mcpResult = await installViaMcp(service, mcpRig)
    const { fetchResult, installResult } = await installViaCli(service, cliRig)

    expect(mcpResult.success).toBe(true)
    expect(mcpResult.install?.version).toBe('1.9.0')
    expect(fetchResult.ok && fetchResult.data.version).toBe('1.9.0')
    expect(installResult?.success).toBe(true)

    const mcpSkillMd = await fs.readFile(
      path.join(mcpRig.skillsDir, 'acme-tool', 'SKILL.md'),
      'utf-8'
    )
    const cliSkillMd = await fs.readFile(
      path.join(cliRig.skillsDir, 'acme-tool', 'SKILL.md'),
      'utf-8'
    )
    // Both transports installed the SAME (1.9.0) content, byte for byte — not just the same
    // version NUMBER, which alone wouldn't catch a transport that resolved the right version
    // string but the wrong row's content.
    expect(mcpSkillMd).toContain(V1_9_MARKER)
    expect(mcpSkillMd).not.toContain(V2_MARKER)
    expect(cliSkillMd).toBe(mcpSkillMd)
  })

  it('an explicit version pins the identical row on both transports', async () => {
    const mcpResult = await installViaMcp(service, mcpRig, '2.0.0')
    const { fetchResult, installResult } = await installViaCli(service, cliRig, '2.0.0')

    expect(mcpResult.install?.version).toBe('2.0.0')
    expect(fetchResult.ok && fetchResult.data.version).toBe('2.0.0')
    expect(installResult?.success).toBe(true)

    const mcpSkillMd = await fs.readFile(
      path.join(mcpRig.skillsDir, 'acme-tool', 'SKILL.md'),
      'utf-8'
    )
    expect(mcpSkillMd).toContain(V2_MARKER)
    const cliSkillMd = await fs.readFile(
      path.join(cliRig.skillsDir, 'acme-tool', 'SKILL.md'),
      'utf-8'
    )
    expect(cliSkillMd).toBe(mcpSkillMd)
  })
})

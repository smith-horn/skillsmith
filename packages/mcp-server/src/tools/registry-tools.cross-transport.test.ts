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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
import {
  createStubRegistryService,
  type PrivateRegistryService,
  type StubRegistryService,
} from './registry-tools.js'
import { createLiveRegistryService } from './registry-tools.live.js'
import { createFakeClient, mockBothClients } from './registry-tools.live.test-helpers.js'

// SMI-5949 Wave 2 Step 5 (plan-review finding M7): the stub/live review-gate PARITY block below
// needs both mocked — neither is touched by this file's pre-existing publish/install-round-trip
// tests above, which drive the stub directly and never resolve a team via Supabase, so mocking
// these here is safe for them.
vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
  resolveUserAccessToken: vi.fn(async () => 'fake-user-access-token'),
}))

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

// ---------------------------------------------------------------------------
// SMI-5949 Wave 2 Step 5 (plan-review finding M7) — stub/live review-gate PARITY
// ---------------------------------------------------------------------------
//
// Exercises `PrivateRegistryService.review()` DIRECTLY on a stub instance and a live instance
// (fake-client-backed), bypassing the tool dispatcher — a SERVICE-level parity proof, not a
// message-format proof (registry-tools.live.review-decision.test.ts already owns verbatim-
// passthrough of the live RPC's own text). The requirement (M7) is error TYPE and ORDER parity:
// both transports must fail at the SAME conceptual D-5 check for the same scenario, not merely
// "both throw". Each case below asserts the expected pattern matches AND that the other three
// documented failure patterns do NOT — proving the right check fired, not an accidental one.
const REVIEW_TEAM = 'team-parity'
const REVIEW_SKILL = 'myteam/parity-skill'
const REVIEW_VERSION = '1.0.0'
const REVIEW_CONTENT = {
  'SKILL.md': '# Parity Skill\n\nUsed only by the review-gate parity tests.',
}

const PARITY_PATTERNS = {
  notAdmin: /not an admin|admins can/i,
  selfApproval: /own submission/i,
  terminal: /already been (approved|rejected)/i,
  missingPublisher: /no recorded submitter|published_by.*NULL/i,
}

/** Asserts `err` matches exactly the ONE expected pattern among the four documented D-5 failure
 *  shapes — proving order, not just type: a hit on the wrong pattern means the wrong check fired. */
function expectOnlyPattern(message: string, expected: keyof typeof PARITY_PATTERNS): void {
  for (const [name, pattern] of Object.entries(PARITY_PATTERNS)) {
    if (name === expected) {
      expect(message).toMatch(pattern)
    } else {
      expect(message).not.toMatch(pattern)
    }
  }
}

/** Live-side RPC error fixture — same four scenarios registry-tools.live.review-decision.test.ts
 *  scripts, reused here so the live half of each parity case is driven by the exact shape the RPC
 *  itself returns, not a hand-rolled approximation. */
function liveRpcError(error: { code: string; message: string }) {
  return {
    rpcResponder: (fn: string) =>
      fn === 'review_private_registry_submission'
        ? { data: null, error }
        : { data: [], error: null },
  }
}

describe('stub/live review-gate error parity (SMI-5949 Wave 2 Step 5, M7)', () => {
  let stub: StubRegistryService

  beforeEach(() => {
    stub = createStubRegistryService()
  })

  it('not-admin: both transports fail at the admin-membership check (D-5 step 3)', async () => {
    const { client } = createFakeClient(
      liveRpcError({
        code: '42501',
        message:
          'Only team admins can review private-registry submissions. This team has no other ' +
          'admin/owner besides the submitter — promote a second admin/owner to unblock review.',
      })
    )
    await mockBothClients(client)
    const live = createLiveRegistryService()
    const liveErr = await live
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((liveErr as Error).message, 'notAdmin')

    await stub.publish(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, REVIEW_CONTENT)
    stub.setActor({ id: 'a-different-non-admin', isAdmin: false })
    const stubErr = await stub
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((stubErr as Error).message, 'notAdmin')
  })

  it('self-approval: both transports fail at self-approval, not the admin check (D-5 step 7 / D-6)', async () => {
    const { client } = createFakeClient(
      liveRpcError({
        code: 'P0001',
        message: 'You cannot approve your own submission. Ask another team admin to review it.',
      })
    )
    await mockBothClients(client)
    const live = createLiveRegistryService()
    const liveErr = await live
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((liveErr as Error).message, 'selfApproval')

    // The publisher must ALSO be admin here (mirrors the plan's smoke matrix, H3): otherwise the
    // admin check (step 3) fires first and this would prove the wrong thing.
    stub.setActor({ id: 'same-actor', isAdmin: true })
    await stub.publish(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, REVIEW_CONTENT)
    const stubErr = await stub
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((stubErr as Error).message, 'selfApproval')
  })

  it('already-decided: both transports fail at the terminal-state check (D-5 step 5 / D-8)', async () => {
    const { client } = createFakeClient(
      liveRpcError({
        code: 'P0001',
        message:
          'This submission has already been approved and cannot be reviewed again — approved ' +
          'and rejected are both terminal decisions.',
      })
    )
    await mockBothClients(client)
    const live = createLiveRegistryService()
    const liveErr = await live
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((liveErr as Error).message, 'terminal')

    stub.setActor({ id: 'publisher', isAdmin: false })
    await stub.publish(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, REVIEW_CONTENT)
    stub.setActor({ id: 'admin-1', isAdmin: true })
    await stub.review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved') // succeeds once
    const stubErr = await stub
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((stubErr as Error).message, 'terminal')
  })

  it('missing published_by: both transports fail at the legacy-client check (D-5 step 6, D-7)', async () => {
    const { client } = createFakeClient(
      liveRpcError({
        code: '23514',
        message:
          'This submission has no recorded submitter (published_by is NULL) and cannot be ' +
          'reviewed — it was published by a client older than the required version. Ask the ' +
          'submitter to upgrade and re-publish.',
      })
    )
    await mockBothClients(client)
    const live = createLiveRegistryService()
    const liveErr = await live
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((liveErr as Error).message, 'missingPublisher')

    // Publish with a null identity — the only way a stub row can lack published_by (see
    // registry-tools.stub.ts's header for why publish() does not itself reject this, unlike the
    // real D-7 trigger).
    stub.setActor({ id: null, isAdmin: false })
    await stub.publish(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, REVIEW_CONTENT)
    stub.setActor({ id: 'admin-1', isAdmin: true })
    const stubErr = await stub
      .review(REVIEW_TEAM, REVIEW_SKILL, REVIEW_VERSION, 'approved')
      .catch((e: Error) => e)
    expectOnlyPattern((stubErr as Error).message, 'missingPublisher')
  })
})

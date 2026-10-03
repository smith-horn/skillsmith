/**
 * SMI-6472 Wave 3 — wire-level regression test for `outputSchema` +
 * `structuredContent` on `search`, `get_skill`, and `skill_validate`.
 *
 * Sits alongside `tools-list-annotations.integration.test.ts` (SMI-6472
 * Wave 2) and reuses its exact harness helpers/pattern: spawns the REAL
 * built server over stdio and drives it with a genuine
 * `@modelcontextprotocol/sdk` `Client`. This is load-bearing here, not just
 * stylistic — the SDK `Client` itself is the conformance checker: it caches
 * a validator per tool from the `outputSchema` seen in `tools/list`
 * (`cacheToolMetadata`, called internally by `client.listTools()`), then on
 * `client.callTool()` it (a) hard-throws if a schema-declaring tool comes
 * back with no `structuredContent`, and (b) validates `structuredContent`
 * against that schema and throws on any mismatch. A schema/response drift
 * therefore surfaces as a thrown error from `callTool()` — the assertions
 * below additionally check specific fields so a passing run isn't only
 * "didn't throw" but also "returned the shape we expect."
 *
 * DB seeding: `get_skill`'s only reachable success path in this fully
 * offline harness (no SUPABASE_URL/ANON_KEY in `baseSpawnEnv`, so
 * `apiClient.isOffline()` is true) is `resolveSkillApiFirst`'s local-DB
 * fallback, which queries `SkillRepository.findById()` against the real
 * sqlite `skills` table — `index_local`'s `LocalIndexer` is a SEPARATE,
 * purely in-memory cache that never touches that table (confirmed by
 * reading `resolveSkillApiFirst`/`LocalIndexer`), so it cannot be used to
 * seed this path. Instead, this suite creates a real file-backed sqlite DB
 * with `createDatabaseAsync` + `initializeSchema` (the same two-call
 * pattern `context.async.ts` itself uses — `createDatabaseAsync` returns a
 * bare connection with no schema, see that file's own comment) and inserts
 * one row via `SkillRepository.create()` (the exact repository API
 * `seedTestData()` in `src/__tests__/test-utils.ts` already uses for
 * in-memory test contexts) BEFORE spawning the harness, then points
 * `SKILLSMITH_DB_PATH` at that file instead of `baseSpawnEnv`'s default
 * `:memory:`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDatabaseAsync,
  initializeSchema,
  closeDatabase,
  SkillRepository,
} from '@skillsmith/core'

import {
  baseSpawnEnv,
  connectHarness,
  createIsolatedHome,
  ensureDistBuilt,
  type HarnessConnection,
} from './agent-harness-sim.helpers.js'

/** The shape this suite reads off the live `tools/list` wire response. */
interface WireTool {
  name: string
  outputSchema?: unknown
  [key: string]: unknown
}

const SEEDED_SKILL_ID = 'anthropic/commit'

describe('SMI-6472 Wave 3 — outputSchema + structuredContent on search/get_skill/skill_validate', () => {
  let cleanupHome: (() => void) | undefined
  let cleanupDbDir: (() => void) | undefined
  let cleanupSkillDir: (() => void) | undefined
  let connection: HarnessConnection | undefined
  let tools: WireTool[] = []
  let validSkillDir = ''

  // Sized like tools-list-annotations.integration.test.ts's own beforeAll —
  // connectHarness() races internally against CONNECT_HARNESS_TIMEOUT_MS
  // (120_000ms); this outer Vitest hook timeout must exceed that with
  // headroom, plus the DB-seed work before the spawn (fast, local sqlite).
  beforeAll(async () => {
    ensureDistBuilt()

    const home = createIsolatedHome('sklx-output-schema-')
    cleanupHome = home.cleanup

    // --- Seed a real, file-backed sqlite DB with one skill -----------------
    const dbDir = mkdtempSync(join(tmpdir(), 'sklx-output-schema-db-'))
    cleanupDbDir = () => rmSync(dbDir, { recursive: true, force: true })
    const dbPath = join(dbDir, 'seed.db')

    const seedDb = await createDatabaseAsync(dbPath)
    initializeSchema(seedDb)
    new SkillRepository(seedDb).create({
      id: SEEDED_SKILL_ID,
      name: 'commit',
      description: 'Generate semantic commit messages following conventional commits',
      author: 'anthropic',
      repoUrl: 'https://github.com/anthropics/claude-code-skills',
      qualityScore: 0.95,
      trustTier: 'verified',
      tags: ['git', 'commit', 'conventional-commits'],
    })
    closeDatabase(seedDb)

    // --- A real temp skill directory for skill_validate ---------------------
    // Frontmatter `name` must match the directory's own basename per
    // `validateNameMatchesDirectory` (SMI-6472 Wave 1) for a clean valid:true
    // pass — exercises the branch where `metadata` is a populated object
    // rather than null.
    const skillDirParent = mkdtempSync(join(tmpdir(), 'sklx-output-schema-skill-'))
    validSkillDir = join(skillDirParent, 'my-test-skill')
    mkdirSync(validSkillDir, { recursive: true })
    writeFileSync(
      join(validSkillDir, 'SKILL.md'),
      [
        '---',
        'name: my-test-skill',
        'description: A minimal test skill used to exercise skill_validate structuredContent output.',
        '---',
        '',
        '# My Test Skill',
        '',
        'Test content for skill_validate structuredContent conformance testing.',
        '',
      ].join('\n')
    )
    cleanupSkillDir = () => rmSync(skillDirParent, { recursive: true, force: true })

    // Override baseSpawnEnv()'s `:memory:` DB and `SKILLSMITH_TOOL_PROFILE:
    // 'agent'` pin (this suite needs the full registered tool set to look up
    // `search`/`get_skill`/`skill_validate`'s `outputSchema` fields).
    const env: Record<string, string> = {
      ...baseSpawnEnv(home.homeDir),
      SKILLSMITH_DB_PATH: dbPath,
    }
    delete env['SKILLSMITH_TOOL_PROFILE']

    connection = await connectHarness({ name: 'tools-output-schema-test', version: '1.0.0' }, env)

    // client.listTools() caches each tool's outputSchema validator
    // internally (cacheToolMetadata) — MUST run before any callTool() below
    // for the SDK's automatic structuredContent validation to engage at all.
    const result = await connection.listTools()
    tools = result.tools as WireTool[]
  }, 150_000)

  afterAll(async () => {
    try {
      if (connection) {
        await connection.close()
      }
    } finally {
      if (cleanupHome) cleanupHome()
      if (cleanupDbDir) cleanupDbDir()
      if (cleanupSkillDir) cleanupSkillDir()
    }
  })

  function requireConnection(): HarnessConnection {
    if (!connection) throw new Error('connectHarness() never completed — see beforeAll failure')
    return connection
  }

  function findTool(name: string): WireTool {
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) {
      throw new Error(
        `Expected tool "${name}" in tools/list response but it was not present. ` +
          `Tools on the wire: ${tools.map((t) => t.name).join(', ')}`
      )
    }
    return tool
  }

  describe('tools/list wire shape', () => {
    it('search declares an object-typed outputSchema', () => {
      const tool = findTool('search')
      expect(tool.outputSchema, 'search.outputSchema was undefined').toBeDefined()
      expect((tool.outputSchema as { type?: unknown }).type).toBe('object')
    })

    it('get_skill declares an object-typed outputSchema', () => {
      const tool = findTool('get_skill')
      expect(tool.outputSchema, 'get_skill.outputSchema was undefined').toBeDefined()
      expect((tool.outputSchema as { type?: unknown }).type).toBe('object')
    })

    it('skill_validate declares an object-typed outputSchema', () => {
      const tool = findTool('skill_validate')
      expect(tool.outputSchema, 'skill_validate.outputSchema was undefined').toBeDefined()
      expect((tool.outputSchema as { type?: unknown }).type).toBe('object')
    })

    it('a sampled tool that should NOT declare an outputSchema (skill_outdated) does not', () => {
      const tool = findTool('skill_outdated')
      expect(
        tool.outputSchema,
        `skill_outdated.outputSchema was: ${JSON.stringify(tool.outputSchema)}`
      ).toBeUndefined()
    })
  })

  describe('callTool round-trips structuredContent, validated by the real SDK Client', () => {
    it('search: an empty/no-match result still returns structuredContent satisfying outputSchema', async () => {
      // A schema/response mismatch throws from callTool() itself (the SDK's
      // own validation) — that would fail this `await` before any assertion
      // below runs, which IS the primary conformance check.
      const result = await requireConnection().callTool({
        name: 'search',
        arguments: { query: 'zzz-no-such-skill-exists-anywhere-xyz-nonce' },
      })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent, 'search did not return structuredContent').toBeDefined()
      const structured = result.structuredContent as Record<string, unknown>
      expect(Array.isArray(structured.results)).toBe(true)
      expect(structured.results).toEqual([])
      expect(typeof structured.total).toBe('number')
      expect(typeof structured.query).toBe('string')
      expect(typeof structured.filters).toBe('object')
      expect(typeof structured.timing).toBe('object')
    })

    it('get_skill: resolves the pre-seeded local-DB skill and returns matching structuredContent', async () => {
      const result = await requireConnection().callTool({
        name: 'get_skill',
        arguments: { id: SEEDED_SKILL_ID },
      })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent, 'get_skill did not return structuredContent').toBeDefined()
      const structured = result.structuredContent as Record<string, unknown>
      const skill = structured.skill as Record<string, unknown>
      expect(skill.id).toBe(SEEDED_SKILL_ID)
      expect(skill.author).toBe('anthropic')
      expect(typeof structured.installCommand).toBe('string')
      expect(typeof structured.timing).toBe('object')
    })

    it('skill_validate: validates a real temp skill directory and returns matching structuredContent', async () => {
      const result = await requireConnection().callTool({
        name: 'skill_validate',
        arguments: { skill_path: validSkillDir },
      })

      expect(result.isError).toBeFalsy()
      expect(
        result.structuredContent,
        'skill_validate did not return structuredContent'
      ).toBeDefined()
      const structured = result.structuredContent as Record<string, unknown>
      expect(typeof structured.valid).toBe('boolean')
      expect(Array.isArray(structured.errors)).toBe(true)
      expect(typeof structured.path).toBe('string')
      expect((structured.path as string).endsWith('SKILL.md')).toBe(true)
    })
  })
})

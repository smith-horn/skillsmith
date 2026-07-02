/**
 * @fileoverview Regression guard: every tool advertised via ListTools must
 * be routable by `dispatchToolCall` (SMI-5477).
 *
 * SMI-5477: `skill_inventory_audit`, `apply_namespace_rename`, and
 * `apply_recommended_edit` were pushed onto `index.ts`'s `toolDefinitions`
 * array (so MCP clients discovered them via `ListTools`) without a matching
 * case in `dispatchToolCall`'s switch, so every real call fell through to
 * the `default` branch's `throw new Error('Unknown tool: ' + name)` — listed
 * but uncallable in every published release for months (fixed by SMI-5470's
 * explicit cases in `tool-dispatch.ts`). No test asserted
 * "listing ⊆ dispatchability", so the break shipped silently.
 *
 * This file parses the ACTUAL `toolDefinitions` array out of `index.ts`'s
 * source text — `index.ts` cannot be imported directly in tests; its
 * top-level `main().catch(...)` starts the real stdio server (see
 * `src/middleware/toolProfile.test.ts` for the same constraint) — and
 * dynamically resolves every entry (plain schema imports AND the two
 * `...builder()` spreads) to its runtime `.name`, exactly mirroring what
 * `index.ts` does at module load. The result is table-driven through
 * `dispatchToolCall`: a tool added to the ListTools array without a
 * matching dispatch case fails this suite BY NAME, automatically — no
 * edit to this file required.
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

// Governance follow-up (SMI-5456): `skill_inventory_audit`'s handler
// (`runInventoryAudit`) is NOT test-isolatable via its public Zod-validated
// args — `homeDir` only redirects what gets SCANNED; `writeAuditHistory` /
// `writeAuditReport` / `writeAuditSuggestions` derive `~/.skillsmith/audits/`
// from `os.homedir()` at MODULE-LOAD time in `audit-history.ts` /
// `audit-suggestions.ts`, so a later `process.env.HOME` mutation (the
// pattern `skill-inventory-audit.test.ts` uses) can't redirect it either —
// see that file's own doc comment on `dedupeAgentPackCollisions` ("no
// test-isolation override exists for that path today"). Left unmocked,
// dispatching `skill_inventory_audit` with `{}` args below scans the REAL
// `~/.claude/` and writes a REAL audit snapshot to the REAL
// `~/.skillsmith/audits/<ulid>/` on every run of this suite — verified via
// a live run (561 -> 562 directories in `$HOME/.skillsmith/audits`). That
// is exactly the unbounded-state-growth side effect
// `SKILLSMITH_INVENTORY_DISABLE` exists to prevent for `inventory_push`
// below. Mock the pipeline entrypoint so this suite's switch-coverage
// assertion for `skill_inventory_audit` never touches the real filesystem.
vi.mock('../../src/audit/run-inventory-audit.js', () => ({
  runInventoryAudit: vi.fn().mockResolvedValue({
    auditId: 'mock-audit-id',
    inventory: [],
    exactCollisions: [],
    genericFlags: [],
    semanticCollisions: [],
    renameSuggestions: [],
    recommendedEdits: [],
    reportPath: '/mock/report.md',
    summary: { totalEntries: 0, totalFlags: 0, errorCount: 0, warningCount: 0, durationMs: 0 },
  }),
}))

import { dispatchToolCall } from '../../src/tool-dispatch.js'
import type { ToolContext } from '../../src/context.types.js'
import type { LicenseMiddleware } from '../../src/middleware/license.js'
import type { QuotaMiddleware } from '../../src/middleware/quota-types.js'

interface ToolLike {
  name: string
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const MCP_SRC_DIR = resolvePath(TEST_DIR, '../../src')
const INDEX_TS_PATH = resolvePath(MCP_SRC_DIR, 'index.ts')
const TOOL_DISPATCH_TS_PATH = resolvePath(MCP_SRC_DIR, 'tool-dispatch.ts')

/** Matches `import { a, b } from './relative.js'` — incl. multi-line and `import type`. */
const IMPORT_RE = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"](\.[^'"]+)['"]/g

/** Build a map of every locally-imported identifier -> its relative module specifier. */
function buildImportMap(indexSource: string): Map<string, string> {
  const map = new Map<string, string>()
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_RE.exec(indexSource)) !== null) {
    const spec = m[2]
    for (const rawName of m[1].split(',')) {
      const name = rawName.trim()
      if (name) map.set(name, spec)
    }
  }
  return map
}

/**
 * Dynamically import the module `identifier` was imported from in
 * `index.ts` and return its export. Throws (naming the identifier) rather
 * than silently skipping, so a future entry this parser can't resolve fails
 * loudly instead of quietly shrinking coverage.
 */
async function loadExport(identifier: string, importMap: Map<string, string>): Promise<unknown> {
  const spec = importMap.get(identifier)
  if (!spec) {
    throw new Error(
      `tool-dispatch.coverage.test.ts: no import found for "${identifier}" in index.ts — ` +
        'the toolDefinitions parser is out of sync with index.ts imports.'
    )
  }
  const absPath = resolvePath(MCP_SRC_DIR, spec.replace(/\.js$/, '.ts'))
  const mod = (await import(pathToFileURL(absPath).href)) as Record<string, unknown>
  const value = mod[identifier]
  if (value === undefined) {
    throw new Error(`tool-dispatch.coverage.test.ts: "${identifier}" has no export in ${spec}`)
  }
  return value
}

/**
 * Parse `toolDefinitions`'s entries out of `index.ts`'s source and resolve
 * each to its runtime tool name(s). A plain entry (e.g. `searchToolSchema`)
 * resolves to one name; a spread builder call (`...newAuditToolDefinitions()`)
 * is invoked for real and every returned element's `.name` is collected —
 * this mirrors exactly what `index.ts` does when it builds `toolDefinitions`,
 * including conditional members (e.g. `apply_recommended_edit` only appears
 * when `APPLY_TEMPLATE_REGISTRY` is non-empty).
 */
async function resolveAdvertisedToolNames(): Promise<string[]> {
  const indexSource = readFileSync(INDEX_TS_PATH, 'utf8')
  const importMap = buildImportMap(indexSource)

  const arrayMatch = indexSource.match(/const toolDefinitions\s*=\s*\[([\s\S]*?)\]/)
  if (!arrayMatch) {
    throw new Error(
      'tool-dispatch.coverage.test.ts: could not find `const toolDefinitions = [...]` in index.ts — ' +
        'update this parser to match the new declaration shape.'
    )
  }

  const names: string[] = []
  for (const rawLine of arrayMatch[1].split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue

    const spread = line.match(/^\.\.\.\s*([A-Za-z0-9_$]+)\s*\(/)
    if (spread) {
      const builder = (await loadExport(spread[1], importMap)) as () => ToolLike[]
      for (const tool of builder()) names.push(tool.name)
      continue
    }

    const plain = line.match(/^([A-Za-z_$][A-Za-z0-9_$]*),?$/)
    if (plain) {
      const schema = (await loadExport(plain[1], importMap)) as ToolLike
      names.push(schema.name)
      continue
    }

    throw new Error(
      `tool-dispatch.coverage.test.ts: unrecognized toolDefinitions entry "${line}" — ` +
        'update this parser to handle the new syntax.'
    )
  }
  return [...new Set(names)]
}

// Top-level await: resolved once, before `describe`/`it.each` register test
// cases below. Precedent: packages/core/src/config/index.test.ts.
const ADVERTISED_TOOL_NAMES = await resolveAdvertisedToolNames()

/** The exact throw signature `dispatchToolCall`'s `default` case uses. */
function unknownToolMessage(name: string): string {
  return `Unknown tool: ${name}`
}

/**
 * Coupling guard: `unknownToolMessage()` above is a string LITERAL that
 * duplicates `tool-dispatch.ts`'s `default` case
 * (`throw new Error('Unknown tool: ' + name)`). If that literal is ever
 * reworded in `tool-dispatch.ts` (e.g. "Tool not found: ") without a
 * matching edit here, `error.message === unknownToolMessage(name)` stops
 * matching for EVERY fallthrough case — this suite would then report every
 * tool as "routed" even ones that silently regressed to the Unknown-tool
 * throw, which is exactly the invisible-success failure mode this file
 * exists to prevent (SMI-5477). Asserted below, exactly once, against the
 * real source, so drift fails this suite loudly instead of silently
 * degrading its coverage to zero.
 */
const UNKNOWN_TOOL_LITERAL = 'Unknown tool: '

// ---------------------------------------------------------------------------
// dispatchToolCall fixture — mirrors src/__tests__/tool-dispatch.test.ts and
// src/__tests__/tool-dispatch.envelope.test.ts EXACTLY (same mock shapes),
// per SMI-5456 worker instructions to reuse the existing convention.
// ---------------------------------------------------------------------------

function createLicenseMw(): LicenseMiddleware {
  return {
    checkFeature: vi.fn().mockResolvedValue({ valid: true }),
    checkTool: vi.fn().mockResolvedValue({ valid: true }),
    getLicenseInfo: vi.fn().mockResolvedValue({
      valid: true,
      tier: 'enterprise' as const,
      features: [],
    }),
    invalidateCache: vi.fn(),
  }
}

function createQuotaMw(): QuotaMiddleware {
  return {
    checkAndTrack: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 999,
      limit: 1000,
      percentUsed: 0.1,
      warningLevel: 0,
      resetAt: new Date(),
    }),
    getStatus: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 999,
      limit: 1000,
      percentUsed: 0.1,
      warningLevel: 0,
      resetAt: new Date(),
    }),
    buildMetadata: vi.fn().mockReturnValue({
      remaining: 999,
      limit: 1000,
      resetAt: new Date().toISOString(),
    }),
    buildExceededResponse: vi.fn().mockReturnValue({
      content: [{ type: 'text' as const, text: 'quota exceeded' }],
      isError: true,
    }),
  }
}

describe('dispatchToolCall — ListTools coverage (SMI-5477 regression guard)', () => {
  // `inventory_push` calls @skillsmith/core's `pushInventory()` unconditionally
  // (no required args, no toolContext gate) — force the local no-op path for
  // this whole suite so switch-coverage testing never makes a real network call.
  const savedInventoryDisable = process.env.SKILLSMITH_INVENTORY_DISABLE

  beforeAll(() => {
    process.env.SKILLSMITH_INVENTORY_DISABLE = '1'
  })

  afterAll(() => {
    if (savedInventoryDisable === undefined) delete process.env.SKILLSMITH_INVENTORY_DISABLE
    else process.env.SKILLSMITH_INVENTORY_DISABLE = savedInventoryDisable
  })

  // Self-check: if the source parser above ever silently regresses to an
  // empty (or near-empty) array — e.g. `index.ts` restructures the
  // `toolDefinitions` declaration in a way this regex can't see — `it.each`
  // below would register close to zero test cases and this file would pass
  // "green" while checking almost nothing. That is precisely the
  // invisible-success failure mode SMI-5477 slipped through; guard it
  // directly rather than trusting the parser implicitly. 35 is a
  // comfortable floor below today's ~41-42 advertised tools.
  it('parsed a plausible number of tools out of index.ts (parser sanity)', () => {
    expect(ADVERTISED_TOOL_NAMES.length).toBeGreaterThanOrEqual(35)
  })

  it('the Unknown-tool throw literal in tool-dispatch.ts still matches this suite (coupling guard)', () => {
    const dispatchSource = readFileSync(TOOL_DISPATCH_TS_PATH, 'utf8')
    const occurrences = dispatchSource.split(UNKNOWN_TOOL_LITERAL).length - 1
    expect(occurrences).toBe(1)
  })

  it.each(ADVERTISED_TOOL_NAMES)(
    'dispatchToolCall routes "%s" to a real handler, not the Unknown-tool throw',
    async (name) => {
      const licenseMiddleware = createLicenseMw()
      const quotaMiddleware = createQuotaMw()

      let unknownToolHit = false
      try {
        await dispatchToolCall(name, {}, {} as ToolContext, licenseMiddleware, quotaMiddleware)
      } catch (error) {
        // Any error OTHER than the exact Unknown-tool signature is a routed
        // call (validation failure, license denial, a handler blowing up on
        // the stubbed ToolContext, etc.) — this test is switch-coverage, not
        // handler correctness, so only the specific unrouted signature fails.
        if (error instanceof Error && error.message === unknownToolMessage(name)) {
          unknownToolHit = true
        }
      }

      expect(unknownToolHit).toBe(false)
    }
  )
})

/**
 * SMI-6472 Wave 2 — wire-level regression test for the `tools/list`
 * `title` + `annotations` passthrough.
 *
 * WHY THIS IS A WIRE TEST, NOT A UNIT TEST: every tool schema constant in
 * `packages/mcp-server/src/tools/*.ts` now carries a top-level `title` and
 * an `annotations: { readOnlyHint, destructiveHint }` object, and
 * `src/index.ts`'s `ListToolsRequestSchema` handler was updated to read and
 * re-emit both fields. But that handler is the ENTIRE wire-visible tool
 * shape — before this fix it mapped every tool to `{ name, description,
 * inputSchema }` only, silently stripping everything else (including
 * `title`/`annotations`) before the response ever left the process. A unit
 * test that imports `searchToolSchema` (etc.) directly and asserts on the
 * exported constant would pass even if that mapping regressed back to the
 * three-field shape — it never exercises the handler that actually produces
 * the wire response. So this suite spawns the REAL built server binary over
 * stdio (`connectHarness()` from `agent-harness-sim.helpers.ts`), performs a
 * genuine MCP `initialize` handshake with a real `@modelcontextprotocol/sdk`
 * `Client`, and asserts directly on the `tools/list` response that crosses
 * the wire — the only place this bug class is actually observable.
 *
 * `baseSpawnEnv()` pins `SKILLSMITH_TOOL_PROFILE: 'agent'`, which makes the
 * server return only a small curated subset of tools (see
 * `middleware/toolProfile.ts`'s `filterToolsForAgentProfile`). This suite
 * needs the FULL registered tool set, so it overrides that key back out of
 * the spawned env while keeping every other isolation/consent kill switch
 * `baseSpawnEnv()` sets.
 *
 * The harness is connected ONCE in `beforeAll` and its `tools/list` response
 * captured once — spawning a real child process + MCP handshake per
 * assertion would be expensive and this suite already runs under container
 * load alongside every other integration file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  baseSpawnEnv,
  connectHarness,
  createIsolatedHome,
  ensureDistBuilt,
  type HarnessConnection,
} from './agent-harness-sim.helpers.js'

/**
 * A sane floor, not the exact live count (43 at time of writing) — a
 * hardcoded exact count would fail every time a tool is added, which is not
 * what this test exists to catch. The real regression this guards against
 * (the field-stripping bug class in the file header) shows up as EVERY tool
 * missing `title`/`annotations`, not as a count drift.
 */
const MIN_EXPECTED_TOOL_COUNT = 40

interface WireToolAnnotations {
  readOnlyHint?: unknown
  destructiveHint?: unknown
  title?: unknown
  [key: string]: unknown
}

/** The shape this suite reads off the live wire response. */
interface WireTool {
  name: string
  title?: unknown
  annotations?: WireToolAnnotations
  [key: string]: unknown
}

describe('SMI-6472 Wave 2 — tools/list wire response carries title + annotations', () => {
  let cleanupHome: (() => void) | undefined
  let connection: HarnessConnection | undefined
  let tools: WireTool[] = []

  // Sized like agent-harness-sim.integration.test.ts's own beforeAll hooks:
  // connectHarness() races internally against CONNECT_HARNESS_TIMEOUT_MS
  // (120_000ms) — this outer Vitest hook timeout must exceed that with
  // headroom so connectHarness()'s own diagnostics-carrying timeout error
  // fires first, rather than a generic Vitest hook-timeout message.
  beforeAll(async () => {
    ensureDistBuilt()

    const home = createIsolatedHome('sklx-tools-list-annotations-')
    cleanupHome = home.cleanup

    // Override baseSpawnEnv()'s SKILLSMITH_TOOL_PROFILE:'agent' pin -- this
    // suite must see the FULL registered tool set, not the curated subset.
    // Every other key (isolation + consent kill switches) is kept as-is.
    const env = { ...baseSpawnEnv(home.homeDir) }
    delete env['SKILLSMITH_TOOL_PROFILE']

    connection = await connectHarness(
      { name: 'tools-list-annotations-test', version: '1.0.0' },
      env
    )

    const result = await connection.listTools()
    tools = result.tools as WireTool[]
  }, 150_000)

  afterAll(async () => {
    // cleanupHome() runs in `finally` so a rejecting close() can never leak
    // the temp isolated HOME dir (matches the sibling harness-sim suite).
    try {
      if (connection) {
        await connection.close()
      }
    } finally {
      if (cleanupHome) {
        cleanupHome()
      }
    }
  })

  /** Looks up one tool by name, failing with a self-diagnosing message (including the full name list) if it's missing from the wire response entirely. */
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

  it('returns the full registered tool set (not the curated agent-profile subset)', () => {
    expect(tools.length).toBeGreaterThanOrEqual(MIN_EXPECTED_TOOL_COUNT)
  })

  it('every tool has a non-empty string `title`', () => {
    const offenders = tools
      .filter((tool) => typeof tool.title !== 'string' || tool.title.trim().length === 0)
      .map((tool) => tool.name)
    expect(offenders, `tools missing a non-empty title: ${offenders.join(', ')}`).toEqual([])
  })

  it('every tool has an `annotations` object with boolean readOnlyHint + destructiveHint', () => {
    const offenders = tools
      .filter((tool) => {
        const annotations = tool.annotations
        if (!annotations || typeof annotations !== 'object') return true
        return (
          typeof annotations.readOnlyHint !== 'boolean' ||
          typeof annotations.destructiveHint !== 'boolean'
        )
      })
      .map((tool) => tool.name)
    expect(
      offenders,
      `tools missing boolean readOnlyHint/destructiveHint annotations: ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('no tool sets both readOnlyHint:true and destructiveHint:true (contradictory)', () => {
    const offenders = tools
      .filter(
        (tool) =>
          tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === true
      )
      .map((tool) => tool.name)
    expect(
      offenders,
      `tools with contradictory readOnlyHint:true + destructiveHint:true: ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('search: readOnlyHint true, destructiveHint false, title "Search Skills"', () => {
    const tool = findTool('search')
    expect(
      tool.annotations,
      `search.annotations was: ${JSON.stringify(tool.annotations)}`
    ).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    })
    expect(tool.title, `search.title was: ${JSON.stringify(tool.title)}`).toBe('Search Skills')
  })

  it('uninstall_skill: readOnlyHint false, destructiveHint true, title "Uninstall Skill"', () => {
    const tool = findTool('uninstall_skill')
    expect(
      tool.annotations,
      `uninstall_skill.annotations was: ${JSON.stringify(tool.annotations)}`
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(tool.title, `uninstall_skill.title was: ${JSON.stringify(tool.title)}`).toBe(
      'Uninstall Skill'
    )
  })

  it('skill_rescan: readOnlyHint false, destructiveHint false (additive-only — proves values are not just a blanket default)', () => {
    const tool = findTool('skill_rescan')
    expect(
      tool.annotations,
      `skill_rescan.annotations was: ${JSON.stringify(tool.annotations)}`
    ).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  })

  it('title is top-level on the tool, not nested inside annotations', () => {
    const tool = findTool('search')
    expect(tool.title, `search.title was: ${JSON.stringify(tool.title)}`).toBe('Search Skills')
    expect(
      tool.annotations?.title,
      `search.annotations.title should be undefined but was: ${JSON.stringify(tool.annotations?.title)}`
    ).toBeUndefined()
  })
})

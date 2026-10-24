/**
 * SMI-7168 Wave 0: input-validation parity across the zod 3 to zod 4 migration.
 *
 * mcp-server's wire schemas are hand-written JSON, but every tool call is
 * validated by a zod schema, and a validation failure is returned to the client
 * as a `ValidationError` envelope carrying each issue's `path`, `message` and
 * `code`. `__fixtures__/input-parity.zod3.json` records, for every exported
 * input schema and a few hundred derived and hand-written inputs, what zod
 * 3.25.76 produced BEFORE the migration: whether the input parsed, the parsed
 * data (defaults applied), and each issue's path, code and message.
 *
 * Every case is run through the real envelope (`safeParseOrError`). Owner
 * decision: clients keep zod 3's codes AND messages, so on both majors the
 * result must equal the baseline exactly. The only excused differences are the
 * pass/fail verdict changes listed in `input-schema-parity.allowlist.ts`, which
 * apply on zod 4 only and are each checked to be live.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { SCHEMA_ENTRIES } from './input-schema-parity.cases.js'
import { deriveCases, run, zodMajorOf, type Fixture } from './input-schema-parity.helpers.js'
import { expectedOnV4, V4_VERDICT_OVERRIDES } from './input-schema-parity.allowlist.js'
import { teamWorkspaceInputSchema } from '../../src/tools/team-workspace.js'
import { safeParseOrError } from '../../src/validation.js'

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/input-parity.zod3.json', import.meta.url), 'utf8')
) as Fixture

const major = zodMajorOf(SCHEMA_ENTRIES[0].schema)

function mismatchesFor(schemaName: string): string[] {
  const entry = SCHEMA_ENTRIES.find((e) => e.name === schemaName)!
  const out: string[] = []
  for (const [label, input] of deriveCases(entry)) {
    const key = `${schemaName}/${label}`
    const want = major === 4 ? expectedOnV4(key, fixture[key]) : fixture[key]
    try {
      expect(run(entry.schema, input)).toEqual(want)
    } catch (err) {
      out.push(`${key}: ${(err as Error).message.split('\n').slice(0, 16).join('\n')}`)
    }
  }
  return out
}

describe(`input validation parity (running on zod ${major}, baseline zod 3)`, () => {
  it('the fixture covers exactly the schemas and cases the table derives', () => {
    const derived = SCHEMA_ENTRIES.flatMap((e) => deriveCases(e).map(([l]) => `${e.name}/${l}`))
    expect(new Set(derived).size).toBe(derived.length)
    expect(derived.sort()).toEqual(Object.keys(fixture).sort())
    expect(SCHEMA_ENTRIES).toHaveLength(44)
    expect(derived.length).toBeGreaterThan(900)
  })

  it('exercises every outcome class, so a matching fixture is not vacuous', () => {
    const all = Object.values(fixture)
    expect(all.filter((o) => o.success).length).toBeGreaterThan(100)
    expect(all.filter((o) => !o.success).length).toBeGreaterThan(500)
    const codes = new Set(all.flatMap((o) => o.issues.map((i) => i.code)))
    expect([...codes].sort()).toEqual(
      [
        'custom',
        'invalid_enum_value',
        'invalid_string',
        'invalid_type',
        'too_big',
        'too_small',
        'unrecognized_keys',
      ].sort()
    )
  })

  it.each(SCHEMA_ENTRIES.map((e) => e.name))('%s matches the baseline', (name) => {
    expect(mismatchesFor(name)).toEqual([])
  })

  it('an unknown enum value reaches the client with zod 3 wording (reviewer case)', () => {
    const result = safeParseOrError(teamWorkspaceInputSchema, { action: 'bogus' }, 'team_workspace')
    expect(result.ok).toBe(false)
    if (result.ok) return
    const envelope = JSON.parse((result.response.content[0] as { text: string }).text) as {
      issues: Array<{ path: string; code: string; message: string }>
    }
    expect(envelope.issues).toEqual([
      {
        path: 'action',
        code: 'invalid_enum_value',
        message:
          "Invalid enum value. Expected 'create' | 'list' | 'get' | 'delete', received 'bogus'",
      },
    ])
  })

  describe('allowlist hygiene', () => {
    it('every verdict override names a baseline case whose outcome it actually changes', () => {
      for (const [key, override] of Object.entries(V4_VERDICT_OVERRIDES)) {
        expect(fixture[key], `${key} must exist in the fixture`).toBeDefined()
        expect(override).not.toEqual(fixture[key])
      }
    })
  })
})

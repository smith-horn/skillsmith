/**
 * SMI-7168 Wave 0: case derivation and outcome recording for the input-schema
 * parity test. Kept apart from the test so the same code can be used to
 * (re)capture the zod 3 fixture.
 */
import {
  SCHEMA_ENTRIES,
  type SchemaEntry,
  type SafeParseLike,
} from './input-schema-parity.cases.js'
import { EXTRA_CASES } from './input-schema-parity.cases.extras.js'
import { safeParseOrError } from '../../src/validation.js'

export interface RecordedIssue {
  path: string
  code: string
  message: string
}

export interface Outcome {
  success: boolean
  data?: unknown
  issues: RecordedIssue[]
}

export type Fixture = Record<string, Outcome>

const UNSAFE_INT = 2 ** 60

/** Which zod major produced a schema. zod 4 instances carry a `_zod` internals object. */
export function zodMajorOf(schema: unknown): 3 | 4 {
  return typeof (schema as { _zod?: unknown })?._zod === 'object' ? 4 : 3
}

function wrongTypeFor(value: unknown): unknown {
  if (typeof value === 'string') return 12345
  if (typeof value === 'number') return 'abc'
  if (typeof value === 'boolean') return 'abc'
  if (Array.isArray(value)) return 'abc'
  return 42
}

function badValuesFor(value: unknown): Array<[string, unknown]> {
  if (typeof value === 'string')
    return [
      ['empty-string', ''],
      ['not-an-option', 'zzz-not-an-option'],
    ]
  if (typeof value === 'number') {
    return [
      ['negative', -1],
      ['fractional', 1.5],
      ['unsafe-int', UNSAFE_INT],
      ['huge', 1e9],
    ]
  }
  if (Array.isArray(value))
    return [
      ['bad-item', [12345]],
      ['empty-string-item', ['']],
    ]
  return []
}

/** Derive every `<label> -> input` case for one schema entry. */
export function deriveCases(entry: SchemaEntry): Array<[string, unknown]> {
  const cases: Array<[string, unknown]> = [
    ['valid', entry.valid],
    ['undefined', undefined],
    ['null', null],
    ['string', 'x'],
    ['empty-object', {}],
  ]
  if (entry.valid !== null && typeof entry.valid === 'object' && !Array.isArray(entry.valid)) {
    const valid = entry.valid as Record<string, unknown>
    cases.push(['unknown-key', { ...valid, __unknown_key__: 1 }])
    for (const key of Object.keys(valid)) {
      const { [key]: _omitted, ...rest } = valid
      void _omitted
      cases.push([`missing:${key}`, rest])
      cases.push([`wrong-type:${key}`, { ...valid, [key]: wrongTypeFor(valid[key]) }])
      for (const [label, bad] of badValuesFor(valid[key])) {
        cases.push([`bad:${key}:${label}`, { ...valid, [key]: bad }])
      }
    }
  } else if (typeof entry.valid === 'string') {
    cases.push(['number', 12345], ['not-an-option', 'zzz-not-an-option'])
  } else {
    cases.push(['number', 12345])
  }
  for (const extra of [...(entry.extras ?? []), ...(EXTRA_CASES[entry.name] ?? [])]) {
    cases.push([`extra:${extra.label}`, extra.input])
  }
  return cases
}

function toJsonSafe(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Run one input through the REAL error envelope (`safeParseOrError`, the path every
 * tool call takes) and record what a client would receive: whether it parsed, the
 * parsed data, and each issue's path, code and message as the envelope serialised
 * them. The zod 3 baseline was captured from a plain `schema.safeParse`, which on
 * zod 3 is exactly what the envelope forwarded.
 */
export function run(schema: SafeParseLike, input: unknown): Outcome {
  const result = safeParseOrError(schema as never, input, 'parity_probe')
  if (result.ok) {
    const outcome: Outcome = { success: true, issues: [] }
    const data = toJsonSafe(result.data)
    if (data !== undefined) outcome.data = data
    return outcome
  }
  const envelope = JSON.parse((result.response.content[0] as { text: string }).text) as {
    error: string
    tool: string
    issues: RecordedIssue[]
  }
  return {
    success: false,
    issues: envelope.issues.map(({ path, code, message }) => ({ path, code, message })),
  }
}

/** Every case for every schema, keyed `<schema>/<case label>`. */
export function recordAll(): Fixture {
  const out: Fixture = {}
  for (const entry of SCHEMA_ENTRIES) {
    for (const [label, input] of deriveCases(entry)) {
      out[`${entry.name}/${label}`] = run(entry.schema, input)
    }
  }
  return out
}

/** One line per case, so a fixture diff shows exactly which cases moved. */
export function serializeFixture(fixture: Fixture): string {
  const lines = Object.entries(fixture).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`
  )
  return `{\n${lines.join(',\n')}\n}\n`
}

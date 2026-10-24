/**
 * SMI-7168: keeps the validation error contract that MCP clients saw on zod 3.
 *
 * zod 4 words and names issues differently (`invalid_enum_value` became
 * `invalid_value`, `invalid_string` became `invalid_format`, `Required` became
 * `Invalid input: expected string, received undefined`, and so on). Owner
 * decision: clients keep receiving today's `code` and `message` strings.
 *
 * Two mechanisms, both supported by zod 4 itself:
 *
 *  1. MESSAGES go through a per-parse contextual error map
 *     (`schema.safeParse(data, { error })`). zod consults it only for an issue
 *     whose schema declared no message of its own, so every message this repo
 *     wrote (`'cwd must be an absolute path'`, `'skill_path is required'`, the
 *     superRefine messages) wins untouched, with no list to maintain. It is
 *     per-call, not `z.config()`, so it cannot leak into `@skillsmith/core` or
 *     the MCP SDK, which share the same hoisted zod instance.
 *  2. CODES cannot be changed by an error map, so the issues are translated
 *     after the parse. `invalid_value` needs the offending input to pick between
 *     zod 3's `invalid_enum_value` (a string that is not an option) and
 *     `invalid_type` (a missing or non-string value), so it is read back from
 *     the arguments by issue path.
 *
 * Wording below reproduces zod 3.25.76's English locale. It is pinned, case by
 * case, by tests/unit/input-schema-parity.test.ts against a zod 3 baseline.
 */
import { z } from 'zod'

export interface LegacyIssue {
  path: PropertyKey[]
  code: string
  message: string
  [extra: string]: unknown
}

export type LegacySafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: LegacyIssue[] } }

type Raw = Record<string, unknown>

/** zod 3's `getParsedType`, which names the received value in its messages. */
function parsedType(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : 'number'
  return typeof value
}

/** zod 3's `joinValues(values, ' | ')`: strings quoted, everything else bare. */
function joinOptions(values: unknown[]): string {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ')
}

function sizeNoun(origin: unknown): string | undefined {
  if (origin === 'string') return 'character(s)'
  if (origin === 'array' || origin === 'set') return 'element(s)'
  return undefined
}

function bound(iss: Raw, kind: 'small' | 'big'): string | undefined {
  const origin = iss.origin
  const limit = kind === 'small' ? iss.minimum : iss.maximum
  const inclusive = iss.inclusive !== false
  if (origin === 'number' || origin === 'int') {
    const word =
      kind === 'small'
        ? inclusive
          ? 'greater than or equal to'
          : 'greater than'
        : inclusive
          ? 'less than or equal to'
          : 'less than'
    return `Number must be ${word} ${String(limit)}`
  }
  const noun = sizeNoun(origin)
  if (!noun) return undefined
  const word =
    kind === 'small' ? (inclusive ? 'at least' : 'over') : inclusive ? 'at most' : 'under'
  const subject = origin === 'string' ? 'String' : 'Array'
  return `${subject} must contain ${word} ${String(limit)} ${noun}`
}

/**
 * zod 3's default message for a raw issue, or undefined to leave zod 4's own
 * wording for an issue kind this repo does not use.
 */
export function legacyErrorMap(rawIssue: unknown): string | undefined {
  const iss = rawIssue as Raw
  switch (iss.code) {
    case 'invalid_type': {
      if (iss.input === undefined) return 'Required'
      if (iss.expected === 'int') return 'Expected integer, received float'
      // zod 4 names a record's expected type 'record'; zod 3 said 'object'.
      const expected = iss.expected === 'record' ? 'object' : String(iss.expected)
      return `Expected ${expected}, received ${parsedType(iss.input)}`
    }
    case 'invalid_value': {
      const values = iss.values as unknown[] | undefined
      if (!Array.isArray(values)) return undefined
      if (iss.input === undefined) return 'Required'
      if (typeof iss.input !== 'string') {
        return `Expected ${joinOptions(values)}, received ${parsedType(iss.input)}`
      }
      return `Invalid enum value. Expected ${joinOptions(values)}, received '${iss.input}'`
    }
    case 'too_small':
      return bound(iss, 'small')
    case 'too_big':
      return bound(iss, 'big')
    case 'invalid_format':
      return iss.format === 'regex' ? 'Invalid' : `Invalid ${String(iss.format)}`
    case 'unrecognized_keys': {
      const keys = (iss.keys as string[] | undefined) ?? []
      return `Unrecognized key(s) in object: ${keys.map((k) => `'${k}'`).join(', ')}`
    }
    case 'custom':
      return 'Invalid input'
    default:
      return undefined
  }
}

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<PropertyKey, unknown>)[key]
  }
  return cur
}

function legacyCode(issue: Raw, args: unknown): string {
  if (issue.code === 'invalid_format') return 'invalid_string'
  if (issue.code === 'invalid_value') {
    const input = valueAt(args, issue.path as PropertyKey[])
    return typeof input === 'string' ? 'invalid_enum_value' : 'invalid_type'
  }
  return issue.code as string
}

/**
 * zod 4 reports an unsafe integer against `.int().max(n)` twice: once for the
 * safe-integer bound and once for `n`. zod 3 reported only `n`. Drop the
 * safe-integer one when a sibling `too_big` already covers the same path.
 */
function dropRedundantSafeIntBound(issues: LegacyIssue[]): LegacyIssue[] {
  return issues.filter((issue) => {
    if (issue.code !== 'too_big' || issue.maximum !== Number.MAX_SAFE_INTEGER) return true
    const key = issue.path.join('.')
    return !issues.some(
      (other) =>
        other !== issue &&
        other.code === 'too_big' &&
        other.maximum !== Number.MAX_SAFE_INTEGER &&
        other.path.join('.') === key
    )
  })
}

/** Drop-in for `schema.safeParse(args)` whose failures carry zod 3's codes and messages. */
export function legacySafeParse<S extends z.ZodType>(
  schema: S,
  args: unknown
): LegacySafeParseResult<z.output<S>> {
  const result = schema.safeParse(args, { error: legacyErrorMap })
  if (result.success) return { success: true, data: result.data }
  const translated = result.error.issues.map(
    (issue) => ({ ...issue, code: legacyCode(issue as unknown as Raw, args) }) as LegacyIssue
  )
  return { success: false, error: { issues: dropRedundantSafeIntBound(translated) } }
}

/** Drop-in for `schema.parse(args)`: throws a `ZodError` whose issues carry zod 3's codes and messages. */
export function legacyParse<S extends z.ZodType>(schema: S, args: unknown): z.output<S> {
  const result = legacySafeParse(schema, args)
  if (result.success) return result.data
  throw new z.ZodError(result.error.issues as unknown as z.core.$ZodIssue[])
}

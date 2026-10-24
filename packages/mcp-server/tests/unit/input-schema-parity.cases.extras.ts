/**
 * SMI-7168: extra parity cases kept apart from `input-schema-parity.cases.ts` (line budget).
 * Negative unsafe integers: zod 4 reports a bound at -Number.MAX_SAFE_INTEGER next to the
 * schema's own `.min()` / `.positive()` issue, where zod 3 reported only the latter.
 */
import { z } from 'zod'
import type { Extra, SchemaEntry } from './input-schema-parity.cases.js'

const NEG_UNSAFE_INT = -(2 ** 60)
const DIFF_BASE = { skillId: 'a/b', oldContent: 'o', newContent: 'n' }

export const EXTRA_CASES: Record<string, Extra[]> = {
  undo_apply: [{ label: 'count-neg-unsafe-int', input: { count: NEG_UNSAFE_INT } }],
  audit_export: [{ label: 'limit-neg-unsafe-int', input: { limit: NEG_UNSAFE_INT } }],
  audit_query: [{ label: 'limit-neg-unsafe-int', input: { limit: NEG_UNSAFE_INT } }],
  skill_diff: [
    { label: 'old-risk-neg-unsafe-int', input: { ...DIFF_BASE, oldRiskScore: NEG_UNSAFE_INT } },
    { label: 'new-risk-neg-unsafe-int', input: { ...DIFF_BASE, newRiskScore: NEG_UNSAFE_INT } },
  ],
}

/**
 * Synthetic schemas for validation shapes no tool declares today but a future one could:
 * an explicit bound equal to the safe-integer limit. zod 4 reports that bound once for the
 * explicit check and once for the safe-integer check; zod 3 reported it once.
 */
export const SYNTHETIC_ENTRIES: SchemaEntry[] = [
  {
    name: 'synthetic_explicit_safe_int_bounds',
    schema: z.object({
      n: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    }),
    valid: { n: 1 },
    extras: [
      { label: 'neg-unsafe-int', input: { n: NEG_UNSAFE_INT } },
      { label: 'pos-unsafe-int', input: { n: 2 ** 60 } },
    ],
  },
]

/**
 * SMI-7168: extra parity cases kept apart from `input-schema-parity.cases.ts` (line budget).
 * Negative unsafe integers: zod 4 reports a bound at -Number.MAX_SAFE_INTEGER next to the
 * schema's own `.min()` / `.positive()` issue, where zod 3 reported only the latter.
 */
import type { Extra } from './input-schema-parity.cases.js'

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

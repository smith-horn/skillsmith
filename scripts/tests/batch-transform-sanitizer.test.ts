/**
 * Tests for stripNullChars (SMI-4935).
 *
 * PostgreSQL `jsonb` cannot represent the NUL code point — an `upsert_skill_
 * transformation` RPC payload carrying a stray NUL fails with
 * `unsupported Unicode escape sequence` and aborts the whole batch run
 * (github/paracetamol951/caisse-enregistreuse-mcp-server). stripNullChars
 * strips NUL from every string in the payload before the RPC.
 *
 * NUL is constructed at runtime via String.fromCharCode(0) so the test source
 * never contains a literal NUL byte.
 */
import { describe, expect, it } from 'vitest'
import { stripNullChars } from '../batch-transform-skills.pipeline'

const NUL = String.fromCharCode(0)

describe('stripNullChars', () => {
  it('strips NUL from a plain string', () => {
    expect(stripNullChars(`a${NUL}b${NUL}c`)).toBe('abc')
  })

  it('leaves a clean string unchanged', () => {
    const clean = '# Skill\n\nA normal markdown body with émojis 🎉 and `\\u0041`.'
    expect(stripNullChars(clean)).toBe(clean)
  })

  it('strips NUL from nested object and array string values', () => {
    const input = {
      p_skill_id: `github/owner/skill${NUL}`,
      p_main_content: `line1${NUL}line2`,
      p_sub_skills: [`sub${NUL}one`, { content: `nested${NUL}value` }],
      p_subagent_definition: { name: 'agent', content: `body${NUL}` },
    }
    expect(stripNullChars(input)).toEqual({
      p_skill_id: 'github/owner/skill',
      p_main_content: 'line1line2',
      p_sub_skills: ['subone', { content: 'nestedvalue' }],
      p_subagent_definition: { name: 'agent', content: 'body' },
    })
  })

  it('preserves non-string values (numbers, booleans, null)', () => {
    const input = {
      p_stats: { count: 3, ok: true, ratio: 0.5 },
      p_subagent_definition: null,
      p_claude_md_snippet: null,
    }
    expect(stripNullChars(input)).toEqual(input)
  })

  it('returns clean payloads unchanged (identity-equal contents)', () => {
    const payload = {
      p_skill_id: 'github/owner/skill',
      p_main_content: '# Title\n\nbody',
      p_sub_skills: ['a', 'b'],
      p_stats: { count: 2 },
      p_source_hash: 'deadbeef',
    }
    expect(stripNullChars(payload)).toEqual(payload)
  })
})

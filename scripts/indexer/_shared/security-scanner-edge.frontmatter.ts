/**
 * SMI-7030: executable-frontmatter detector (flag-only)
 * @module scripts/indexer/_shared/security-scanner-edge.frontmatter (Node port)
 *
 * Structural detector for a SKILL.md whose frontmatter opener names the
 * `js` / `javascript` engine (`---js`). gray-matter 4.0.3, used by
 * `@skillsmith/cli` <= 0.8.13's `import-local`, evaluates that block with a
 * direct `eval`. The payload is arbitrary JavaScript, so the rule keys on the
 * opener itself and never on the block's contents.
 *
 * Flag-only: the finding is `critical`/`high` for reporting, but its category
 * coefficient is 0 (security-scanner-edge.weights.ts), so it never moves
 * riskScore and can never quarantine. It is deliberately NOT routed through
 * `classifyMatch`: the context model only recognises a bare `---` opener, so
 * a `---js` block would be mis-classified. Runs on the outer document only.
 * Kept byte-identical to its supabase/functions/_shared twin (parity test
 * enforces).
 */

// ============================================================================
// executable_frontmatter: gray-matter js/javascript opener
// ============================================================================

import type { SecurityFinding } from './security-scanner-edge.context.ts'

// Mirrors gray-matter 4.0.3 opener + language detection (index.js:69-90,205-217; engine.js).
export function opensWithExecutableFrontmatter(content: string): boolean {
  const s = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content // strip-bom-string: one BOM
  if (!s.startsWith('---')) return false
  const rest = s.slice(3)
  const name = rest.slice(0, rest.search(/\r?\n/)).trim().toLowerCase() // -1 → slice(0,-1), as gray-matter
  return name === 'js' || name === 'javascript'
}

/**
 * One finding per document, at line 1. Call with the OUTER document only; the
 * caller must not invoke it for decoded-blob rescans.
 */
export function scanExecutableFrontmatter(content: string): SecurityFinding[] {
  if (!opensWithExecutableFrontmatter(content)) return []
  return [
    {
      type: 'executable_frontmatter',
      severity: 'critical',
      message:
        'frontmatter opens with an executable language tag (---js / ---javascript); older gray-matter-based importers evaluate it as code',
      lineNumber: 1,
      confidence: 'high',
    },
  ]
}

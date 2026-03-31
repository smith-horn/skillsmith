/**
 * Unit tests for SkillCompletionProvider
 * Validates snippet integrity for YAML frontmatter fields.
 */
import { describe, it, expect } from 'vitest'
import { FRONTMATTER_FIELDS } from '../intellisense/completionData.js'

describe('SkillCompletionProvider', () => {
  describe('FRONTMATTER_FIELDS snippets have balanced quotes', () => {
    for (const field of FRONTMATTER_FIELDS) {
      it(`${field.name} has balanced quotes`, () => {
        const quotes = (field.insertText.match(/"/g) || []).length
        expect(quotes % 2).toBe(0)
      })
    }
  })
})

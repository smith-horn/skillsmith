import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SOURCE_PATH = path.resolve(__dirname, '../intellisense/SkillCompletionProvider.ts')

describe('SkillCompletionProvider', () => {
  describe('FRONTMATTER_FIELDS snippet balance', () => {
    it('all insertText values with double-quotes should have balanced quotes', () => {
      const source = fs.readFileSync(SOURCE_PATH, 'utf-8')
      const insertTextMatches = source.matchAll(/insertText:\s*'([^']+)'/g)
      for (const m of insertTextMatches) {
        const text = m[1]!
        const quoteCount = (text.match(/"/g) || []).length
        expect(quoteCount % 2, `Unbalanced quotes in insertText: ${text}`).toBe(0)
      }
    })

    it('category snippet should produce valid YAML with closing quote', () => {
      const source = fs.readFileSync(SOURCE_PATH, 'utf-8')
      // Find the category insertText (multiline: the field spans lines)
      const categoryMatch = source.match(/category[\s\S]*?insertText:\s*'([^']+)'/)
      expect(categoryMatch).not.toBeNull()
      const insertText = categoryMatch![1]
      // After VS Code expands the snippet choice, the result should end with "
      // The snippet syntax ${1|...|} expands to one of the choices
      // So the template is: category: "CHOICE"
      // Check the template ends with "
      expect(insertText).toMatch(/"$/)
    })
  })
})

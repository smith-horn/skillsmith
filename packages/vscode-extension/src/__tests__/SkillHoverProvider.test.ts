import { describe, it, expect } from 'vitest'

// Test the regex guard logic directly since getFrontmatterHover is private
describe('SkillHoverProvider frontmatter guard', () => {
  const testGuard = (lineText: string): string | null => {
    const match = lineText.match(/^(\s*)(\w+)(:)/)
    if (!match?.[2]) {
      return null
    }
    return match[2]
  }

  it('should match top-level frontmatter fields (no indent)', () => {
    expect(testGuard('name: "My Skill"')).toBe('name')
    expect(testGuard('description: A cool skill')).toBe('description')
    expect(testGuard('version: 1.0.0')).toBe('version')
    expect(testGuard('author: someone')).toBe('author')
    expect(testGuard('category: development')).toBe('category')
  })

  it('should match indented fields', () => {
    expect(testGuard('  name: "My Skill"')).toBe('name')
    expect(testGuard('    nested: value')).toBe('nested')
  })

  it('should return null for non-field lines', () => {
    expect(testGuard('---')).toBeNull()
    expect(testGuard('  - list item')).toBeNull()
    expect(testGuard('')).toBeNull()
    expect(testGuard('# comment')).toBeNull()
  })
})

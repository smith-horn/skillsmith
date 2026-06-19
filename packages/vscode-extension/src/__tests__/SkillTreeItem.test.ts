/**
 * Tests for SkillTreeItem.formatDescription (#1436 / SMI-5307)
 *
 * All assertions go through the public `SkillTreeItem.createSkill(data)`
 * factory so that the description format is tested as callers observe it —
 * no access to the private `formatDescription` method.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('vscode', () => {
  class TreeItem {
    constructor(
      public label: string,
      public collapsibleState?: number
    ) {}
    iconPath?: unknown
    description?: string
    tooltip?: unknown
    contextValue?: string
    command?: unknown
    id?: string
  }
  return {
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    MarkdownString: class {
      value = ''
      isTrusted = true
      appendMarkdown(s: string) {
        this.value += s
        return this
      }
      appendText(s: string) {
        this.value += s
        return this
      }
      appendCodeblock() {
        return this
      }
    },
    ThemeIcon: class {
      constructor(
        public id: string,
        public color?: unknown
      ) {}
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
  }
})

import { SkillTreeItem } from '../sidebar/SkillTreeItem.js'
import type { SkillItemData } from '../sidebar/SkillTreeItem.js'

/** Minimal base data — override per test */
const base: SkillItemData = {
  id: 'test/skill',
  name: 'Test Skill',
  description: undefined,
  isInstalled: false,
}

describe('SkillTreeItem.formatDescription (#1436 / SMI-5307)', () => {
  it('all four segments present → joined with U+00B7 middle dot', () => {
    const item = SkillTreeItem.createSkill({
      ...base,
      author: 'Alice',
      category: 'testing',
      score: 90,
      installedElsewhere: true,
    })
    expect(item.description).toBe('by Alice · testing · 90/100 · ✓ Installed')
  })

  it('author only → "by {author}"', () => {
    const item = SkillTreeItem.createSkill({ ...base, author: 'Alice' })
    expect(item.description).toBe('by Alice')
  })

  it('score 0 → included as "0/100" (zero is not omitted)', () => {
    const item = SkillTreeItem.createSkill({ ...base, score: 0 })
    expect(item.description).toContain('0/100')
  })

  it('score undefined → no score segment', () => {
    const item = SkillTreeItem.createSkill({ ...base, author: 'Alice', category: 'cat' })
    expect(item.description).not.toContain('/100')
    expect(item.description).toBe('by Alice · cat')
  })

  it('no fields at all → empty string', () => {
    const item = SkillTreeItem.createSkill({ ...base })
    expect(item.description).toBe('')
  })

  it('installedElsewhere true → description ends with "✓ Installed"', () => {
    const item = SkillTreeItem.createSkill({ ...base, installedElsewhere: true })
    expect(item.description).toBe('✓ Installed')
  })

  it('installedElsewhere absent (undefined) → no "✓ Installed" marker', () => {
    const item = SkillTreeItem.createSkill({ ...base, author: 'Bob' })
    expect(item.description).not.toContain('✓ Installed')
  })

  it('category and score without author → correct order, no "by" prefix', () => {
    const item = SkillTreeItem.createSkill({ ...base, category: 'devops', score: 75 })
    expect(item.description).toBe('devops · 75/100')
  })

  // Regression guard — H4: installedElsewhere must NOT leak into contextValue.
  // An available item with installedElsewhere:true must stay contextValue='skill'
  // so getParent() routes it to the Available group, not the Installed group.
  it('regression guard: installedElsewhere:true + isInstalled:false → contextValue "skill"', () => {
    const item = SkillTreeItem.createSkill({
      ...base,
      isInstalled: false,
      installedElsewhere: true,
    })
    expect(item.contextValue).toBe('skill')
  })

  it('regression guard: isInstalled:true → contextValue "installedSkill"', () => {
    const item = SkillTreeItem.createSkill({
      ...base,
      isInstalled: true,
    })
    expect(item.contextValue).toBe('installedSkill')
  })

  it('trust-tier label is NOT present in description (redundant with icon)', () => {
    const item = SkillTreeItem.createSkill({
      ...base,
      author: 'Alice',
      trustTier: 'verified',
    })
    // Trust tier labels like "Verified" must not appear in the description line.
    expect(item.description).not.toMatch(/verified/i)
    expect(item.description).toBe('by Alice')
  })
})

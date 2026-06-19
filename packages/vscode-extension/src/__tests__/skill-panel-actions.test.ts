/**
 * Tests for skill-panel-actions.ts (SMI-5308).
 * Covers the conditional action block: Install (available) vs
 * Uninstall + Open Folder + Open SKILL.md (installed), aria-labels, and the
 * SKILL.md gate.
 */
import { describe, it, expect } from 'vitest'
import { getActionBlock } from '../views/skill-panel-actions.js'

const REPO = 'https://github.com/tester/test-skill'

describe('getActionBlock', () => {
  describe('available state (not installed)', () => {
    it('renders the Install button only when there is no repository', () => {
      const html = getActionBlock({ installed: false }, '')
      expect(html).toContain('id="installBtn"')
      expect(html).toContain('Install Skill')
      expect(html).not.toContain('id="repoBtn"')
      expect(html).not.toContain('id="uninstallBtn"')
      expect(html).not.toContain('id="openFolderBtn"')
    })

    it('adds the View Repository button when a repository is present', () => {
      const html = getActionBlock({ installed: false }, REPO)
      expect(html).toContain('id="installBtn"')
      expect(html).toContain('id="repoBtn"')
      expect(html).toContain('View Repository')
      expect(html).toContain(`data-url="${REPO}"`)
    })
  })

  describe('installed state', () => {
    it('renders Uninstall + Open Folder + Open SKILL.md when hasSkillMd', () => {
      const html = getActionBlock(
        { installed: true, skillPath: '/skills/test-skill', hasSkillMd: true },
        ''
      )
      expect(html).toContain('id="uninstallBtn"')
      expect(html).toContain('btn-destructive')
      expect(html).toContain('id="openFolderBtn"')
      expect(html).toContain('id="openSkillFileBtn"')
      expect(html).toContain('Open SKILL.md')
      expect(html).not.toContain('id="installBtn"')
    })

    it('omits Open SKILL.md when hasSkillMd is false', () => {
      const html = getActionBlock(
        { installed: true, skillPath: '/skills/test-skill', hasSkillMd: false },
        ''
      )
      expect(html).toContain('id="uninstallBtn"')
      expect(html).toContain('id="openFolderBtn"')
      expect(html).not.toContain('id="openSkillFileBtn"')
    })

    it('omits Open SKILL.md when hasSkillMd is undefined', () => {
      const html = getActionBlock({ installed: true, skillPath: '/skills/test-skill' }, '')
      expect(html).not.toContain('id="openSkillFileBtn"')
    })

    it('keeps the repo button alongside the installed actions when present', () => {
      const html = getActionBlock(
        { installed: true, skillPath: '/skills/test-skill', hasSkillMd: true },
        REPO
      )
      expect(html).toContain('id="repoBtn"')
      expect(html).toContain('id="uninstallBtn"')
    })
  })

  describe('accessibility', () => {
    it('gives every available-state action an explicit aria-label', () => {
      const html = getActionBlock({ installed: false }, REPO)
      expect(html).toContain('aria-label="Install this skill"')
      expect(html).toContain('aria-label="View the source repository"')
    })

    it('gives every installed-state action an explicit aria-label', () => {
      const html = getActionBlock(
        { installed: true, skillPath: '/skills/test-skill', hasSkillMd: true },
        ''
      )
      expect(html).toContain('aria-label="Uninstall this skill"')
      expect(html).toContain('aria-label="Open the skill folder"')
      expect(html).toContain('aria-label="Open SKILL.md"')
    })
  })

  describe('security', () => {
    it('escapes a repository URL with HTML metacharacters', () => {
      const html = getActionBlock({ installed: false }, 'https://x.test/"><script>')
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
    })
  })
})

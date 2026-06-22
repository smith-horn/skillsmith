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
      expect(html).not.toContain('id="diffBtn"')
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

    it('renders diffBtn with btn-secondary and correct aria-label in installed state', () => {
      const html = getActionBlock(
        { installed: true, skillPath: '/skills/test-skill', hasSkillMd: true },
        ''
      )
      expect(html).toContain('id="diffBtn"')
      expect(html).toContain('btn-secondary')
      expect(html).toContain('aria-label="View changes for this skill"')
      expect(html).toContain('View changes')
    })

    it('renders diffBtn even when hasSkillMd is false', () => {
      const html = getActionBlock(
        { installed: true, skillPath: '/skills/test-skill', hasSkillMd: false },
        ''
      )
      expect(html).toContain('id="diffBtn"')
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

  describe('repository URL handling', () => {
    it('interpolates an already-escaped URL without double-encoding (&amp; stays &amp;)', () => {
      // The caller (getSkillDetailHtml) pre-escapes the URL. getActionBlock must
      // NOT re-escape, or `&` in a query string becomes `&amp;amp;` and the
      // webview opens the wrong URL.
      const safe = 'https://x.test/repo?a=1&amp;b=2'
      const html = getActionBlock({ installed: false }, safe)
      expect(html).toContain('data-url="https://x.test/repo?a=1&amp;b=2"')
      expect(html).not.toContain('&amp;amp;')
    })

    it('emits no raw script tag for a properly pre-escaped URL', () => {
      const safe = 'https://x.test/&quot;&gt;&lt;script&gt;'
      const html = getActionBlock({ installed: false }, safe)
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
    })
  })
})

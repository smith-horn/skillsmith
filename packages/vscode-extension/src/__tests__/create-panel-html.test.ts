/**
 * Tests for views/create-panel-html.ts (SMI-5313 / GH #1454).
 *
 * Verifies the static HTML document rendered once by CreateSkillPanel:
 * all four form fields, three type radios, CSP embedding, and aria-live slots.
 */
import { describe, it, expect } from 'vitest'
import { getCreateSkillHtml } from '../views/create-panel-html.js'

const NONCE = 'test-nonce-abcdefgh'
const CSP = "default-src 'none'; script-src 'nonce-test-nonce-abcdefgh';"

describe('getCreateSkillHtml', () => {
  const html = getCreateSkillHtml(NONCE, CSP)

  describe('form fields', () => {
    it('renders the author field', () => {
      expect(html).toContain('id="author"')
      expect(html).toContain('name="author"')
    })

    it('renders the name field', () => {
      expect(html).toContain('id="name"')
      expect(html).toContain('name="name"')
    })

    it('renders the description field', () => {
      expect(html).toContain('id="description"')
      expect(html).toContain('name="description"')
    })

    it('renders the type fieldset', () => {
      expect(html).toContain('name="type"')
    })
  })

  describe('type radios', () => {
    it('renders basic radio option', () => {
      expect(html).toContain('value="basic"')
    })

    it('renders intermediate radio option', () => {
      expect(html).toContain('value="intermediate"')
    })

    it('renders advanced radio option', () => {
      expect(html).toContain('value="advanced"')
    })

    it('selects basic by default', () => {
      expect(html).toContain('value="basic" checked')
    })
  })

  describe('CSP', () => {
    it('embeds the passed CSP string in the meta tag', () => {
      expect(html).toContain(`content="${CSP}"`)
    })

    it('includes Content-Security-Policy in the meta tag', () => {
      expect(html).toContain('http-equiv="Content-Security-Policy"')
    })
  })

  describe('aria-live error slots', () => {
    it('author error slot has aria-live="polite"', () => {
      expect(html).toContain('id="authorError"')
      // The error span should have aria-live
      const authorErrorIdx = html.indexOf('id="authorError"')
      const surroundingSnippet = html.slice(Math.max(0, authorErrorIdx - 100), authorErrorIdx + 100)
      expect(surroundingSnippet).toContain('aria-live="polite"')
    })

    it('name error slot has aria-live="polite"', () => {
      expect(html).toContain('id="nameError"')
      const nameErrorIdx = html.indexOf('id="nameError"')
      const surroundingSnippet = html.slice(Math.max(0, nameErrorIdx - 100), nameErrorIdx + 100)
      expect(surroundingSnippet).toContain('aria-live="polite"')
    })

    it('description error slot has aria-live="polite"', () => {
      expect(html).toContain('id="descriptionError"')
      const descErrorIdx = html.indexOf('id="descriptionError"')
      const surroundingSnippet = html.slice(Math.max(0, descErrorIdx - 100), descErrorIdx + 100)
      expect(surroundingSnippet).toContain('aria-live="polite"')
    })

    it('type error slot exists with aria-live="polite" (M1)', () => {
      expect(html).toContain('id="typeError"')
      const typeErrorIdx = html.indexOf('id="typeError"')
      const surroundingSnippet = html.slice(Math.max(0, typeErrorIdx - 100), typeErrorIdx + 100)
      expect(surroundingSnippet).toContain('aria-live="polite"')
    })

    it('renders multiple aria-live="polite" slots (at least 3)', () => {
      const matches = html.match(/aria-live="polite"/g) ?? []
      expect(matches.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('nonce', () => {
    it('includes nonce in the script tag', () => {
      expect(html).toContain(`nonce="${NONCE}"`)
    })
  })

  describe('structure', () => {
    it('is a full HTML document', () => {
      expect(html).toContain('<!DOCTYPE html>')
      expect(html).toContain('<html')
      expect(html).toContain('</html>')
    })

    it('contains the form element', () => {
      expect(html).toContain('id="createForm"')
    })

    it('contains the Create Skill button', () => {
      expect(html).toContain('id="createBtn"')
    })

    it('contains the CLI log output area', () => {
      expect(html).toContain('id="cliLog"')
    })
  })
})

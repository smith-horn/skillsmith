/**
 * Tests for views/create-panel-script.ts (SMI-5313 / GH #1454).
 *
 * Verifies the webview script body returned by getCreateScript:
 * - validateName / submit postMessage wiring
 * - No innerHTML anywhere (H3)
 * - cliOutput uses textContent += (H3/M5)
 * - Null-guards on all getElementById calls
 * - Create button is type=button wired via click (not form submit)
 */
import { describe, it, expect } from 'vitest'
import { getCreateScript } from '../views/create-panel-script.js'

const NONCE = 'test-nonce-script-xyz'

describe('getCreateScript', () => {
  const script = getCreateScript(NONCE)

  describe('H3: no innerHTML assignment anywhere', () => {
    it('does not assign innerHTML (no "= innerHTML" or ".innerHTML =")', () => {
      // Comments may mention innerHTML as a safety note (e.g. "NEVER innerHTML")
      // but no actual assignment should exist. Check for the assignment operator pattern.
      expect(script).not.toMatch(/\.innerHTML\s*=(?!=)/)
      expect(script).not.toMatch(/\.innerHTML\s*\+=/)
    })
  })

  describe('H3/M5: cliOutput uses textContent +=', () => {
    it('appends cliOutput chunks via textContent +=', () => {
      expect(script).toContain('textContent +=')
    })

    it('the cliOutput case uses textContent += for appending', () => {
      const cliOutputIdx = script.indexOf("case 'cliOutput'")
      const snippet = script.slice(cliOutputIdx, cliOutputIdx + 300)
      expect(snippet).toContain('textContent')
      // No innerHTML assignment in this block
      expect(snippet).not.toMatch(/\.innerHTML\s*[+]?=(?!=)/)
    })
  })

  describe('validateName postMessage wiring', () => {
    it('posts validateName on name input event', () => {
      expect(script).toContain("command: 'validateName'")
      expect(script).toContain("'input'")
    })

    it('handles nameValidity response', () => {
      expect(script).toContain("case 'nameValidity'")
    })
  })

  describe('submit postMessage wiring', () => {
    it('posts submit command on Create button click', () => {
      expect(script).toContain("command: 'submit'")
      expect(script).toContain("'click'")
    })

    it('Create button is wired via click listener (not form submit event)', () => {
      // The button is type=button; the script uses addEventListener('click')
      expect(script).toContain("addEventListener('click'")
      // No submit event listener on the form
      expect(script).not.toContain("addEventListener('submit'")
    })

    it('handles submitError response', () => {
      expect(script).toContain("case 'submitError'")
    })

    it('wires the type-field error slot (M1)', () => {
      expect(script).toContain('typeError')
      expect(script).toContain('errors.type')
    })
  })

  describe('null-guards', () => {
    it('null-guards nameInput', () => {
      expect(script).toContain('nameInput')
      expect(script).toMatch(/if\s*\(\s*nameInput\s*\)/)
    })

    it('null-guards createBtn', () => {
      expect(script).toContain('createBtn')
      expect(script).toMatch(/if\s*\(\s*createBtn\s*\)/)
    })

    it('null-guards cliLog', () => {
      expect(script).toContain('cliLog')
      expect(script).toMatch(/if\s*\(\s*cliLog/)
    })
  })

  describe('message handler wiring', () => {
    it('listens for window message events', () => {
      expect(script).toContain("window.addEventListener('message'")
    })

    it('handles creating command (disables form)', () => {
      expect(script).toContain("case 'creating'")
    })

    it('handles createFailed command (re-enables form)', () => {
      expect(script).toContain("case 'createFailed'")
    })
  })

  describe('vscode API', () => {
    it('acquires the VS Code API', () => {
      expect(script).toContain('acquireVsCodeApi()')
    })
  })

  describe('text content safety', () => {
    it('uses textContent (not innerHTML) for error messages', () => {
      // setText helper uses el.textContent
      expect(script).toContain('textContent')
    })
  })
})

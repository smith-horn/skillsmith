/**
 * Tests for VS Code webview CSP utilities
 */
import { describe, it, expect } from 'vitest'
import {
  generateCspNonce,
  buildWebviewCsp,
  isValidNonce,
  createCspMetaTag,
  getSkillDetailCsp,
  getSearchResultsCsp,
  validateCsp,
  type WebviewCspConfig,
} from '../csp.js'

describe('VS Code CSP Utilities', () => {
  describe('generateCspNonce', () => {
    it('should generate a nonce', () => {
      const nonce = generateCspNonce()
      expect(nonce).toBeDefined()
      expect(typeof nonce).toBe('string')
    })

    it('should generate nonces of exactly 32 characters', () => {
      const nonce = generateCspNonce()
      expect(nonce.length).toBe(32)
    })

    it('should generate unique nonces', () => {
      const nonce1 = generateCspNonce()
      const nonce2 = generateCspNonce()
      expect(nonce1).not.toBe(nonce2)
    })

    it('should generate alphanumeric nonces', () => {
      const nonce = generateCspNonce()
      expect(nonce).toMatch(/^[A-Za-z0-9]+$/)
    })
  })

  describe('isValidNonce', () => {
    it('should validate a proper nonce', () => {
      const nonce = generateCspNonce()
      expect(isValidNonce(nonce)).toBe(true)
    })

    it('should reject empty nonce', () => {
      expect(isValidNonce('')).toBe(false)
    })

    it('should reject short nonce', () => {
      expect(isValidNonce('short')).toBe(false)
      expect(isValidNonce('123456789012345')).toBe(false)
    })

    it('should reject non-alphanumeric nonce', () => {
      expect(isValidNonce('abcd1234!@#$5678')).toBe(false)
      expect(isValidNonce('abcd1234-efgh5678')).toBe(false)
    })

    it('should accept 16+ character alphanumeric nonce', () => {
      expect(isValidNonce('abcdefghijklmnop')).toBe(true)
      expect(isValidNonce('1234567890123456')).toBe(true)
    })
  })

  describe('buildWebviewCsp', () => {
    const nonce = 'test-nonce-1234567890123456'

    it('should build basic CSP with default config', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain(`script-src 'nonce-${nonce}'`)
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-src 'none'")
    })

    it('should include nonce in script-src', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain(`script-src 'nonce-${nonce}'`)
    })

    it('should use unsafe-inline for styles when allowInlineStyles is true', () => {
      const config: WebviewCspConfig = {
        allowInlineStyles: true,
      }
      const csp = buildWebviewCsp(nonce, config)
      expect(csp).toContain("style-src 'unsafe-inline'")
    })

    it('should use nonce for styles when allowInlineStyles is false', () => {
      const config: WebviewCspConfig = {
        allowInlineStyles: false,
      }
      const csp = buildWebviewCsp(nonce, config)
      expect(csp).toContain(`style-src 'nonce-${nonce}'`)
    })

    it('should include vscode-resource when allowVscodeResources is true', () => {
      const config: WebviewCspConfig = {
        allowVscodeResources: true,
      }
      const csp = buildWebviewCsp(nonce, config)
      expect(csp).toContain('vscode-resource:')
    })

    it('should not include vscode-resource when allowVscodeResources is false', () => {
      const config: WebviewCspConfig = {
        allowVscodeResources: false,
      }
      const csp = buildWebviewCsp(nonce, config)
      expect(csp).not.toContain('vscode-resource:')
    })

    it('should include additional script sources', () => {
      const config: WebviewCspConfig = {
        scriptSrc: ['https://example.com'],
      }
      const csp = buildWebviewCsp(nonce, config)
      expect(csp).toContain('https://example.com')
    })

    it('should include additional style sources', () => {
      const config: WebviewCspConfig = {
        styleSrc: ['https://fonts.googleapis.com'],
      }
      const csp = buildWebviewCsp(nonce, config)
      expect(csp).toContain('https://fonts.googleapis.com')
    })

    it('should include additional image sources', () => {
      const config: WebviewCspConfig = {
        imgSrc: ['https://cdn.example.com'],
      }
      const csp = buildWebviewCsp(nonce, config)
      expect(csp).toContain('https://cdn.example.com')
    })

    it('should include additional font sources', () => {
      const config: WebviewCspConfig = {
        allowVscodeResources: false,
        fontSrc: ['https://fonts.gstatic.com'],
      }
      const csp = buildWebviewCsp(nonce, config)
      expect(csp).toContain('https://fonts.gstatic.com')
    })

    it('should include data: and https: in img-src by default', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toMatch(/img-src.*https:/)
      expect(csp).toMatch(/img-src.*data:/)
    })

    it('should deny connections by default', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain("connect-src 'none'")
    })

    it('should deny forms by default', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain("form-action 'none'")
    })
  })

  describe('createCspMetaTag', () => {
    const nonce = 'test-nonce-1234567890123456'

    it('should create a meta tag', () => {
      const tag = createCspMetaTag(nonce)
      expect(tag).toContain('<meta')
      expect(tag).toContain('http-equiv="Content-Security-Policy"')
      expect(tag).toContain('content=')
    })

    it('should include nonce in the CSP', () => {
      const tag = createCspMetaTag(nonce)
      expect(tag).toContain(`'nonce-${nonce}'`)
    })

    it('should accept custom config', () => {
      const config: WebviewCspConfig = {
        allowInlineStyles: true,
      }
      const tag = createCspMetaTag(nonce, config)
      expect(tag).toContain("'unsafe-inline'")
    })

    it('should throw for invalid nonce', () => {
      expect(() => createCspMetaTag('short')).toThrow('Invalid CSP nonce')
    })

    it('should throw for non-alphanumeric nonce', () => {
      expect(() => createCspMetaTag('invalid-nonce-!@#$')).toThrow('Invalid CSP nonce')
    })
  })

  describe('getSkillDetailCsp', () => {
    const nonce = 'test-nonce-1234567890123456'

    it('should return CSP for skill details', () => {
      const csp = getSkillDetailCsp(nonce)
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain(`script-src 'nonce-${nonce}'`)
    })

    it('should allow inline styles for VS Code variables', () => {
      const csp = getSkillDetailCsp(nonce)
      expect(csp).toContain("'unsafe-inline'")
    })

    it('should allow VS Code resources', () => {
      const csp = getSkillDetailCsp(nonce)
      expect(csp).toContain('vscode-resource:')
    })

    it('should allow https and data images', () => {
      const csp = getSkillDetailCsp(nonce)
      expect(csp).toMatch(/img-src.*https:/)
      expect(csp).toMatch(/img-src.*data:/)
    })
  })

  describe('getSearchResultsCsp', () => {
    const nonce = 'test-nonce-1234567890123456'

    it('should return CSP for search results', () => {
      const csp = getSearchResultsCsp(nonce)
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain(`script-src 'nonce-${nonce}'`)
    })

    it('should allow inline styles', () => {
      const csp = getSearchResultsCsp(nonce)
      expect(csp).toContain("'unsafe-inline'")
    })

    it('should allow VS Code resources', () => {
      const csp = getSearchResultsCsp(nonce)
      expect(csp).toContain('vscode-resource:')
    })
  })

  describe('validateCsp', () => {
    it('should validate a good CSP', () => {
      const csp = "default-src 'self'; script-src 'self'"
      const result = validateCsp(csp)
      expect(result.valid).toBe(true)
      expect(result.warnings).toHaveLength(0)
    })

    it('should warn about unsafe-eval', () => {
      const csp = "script-src 'self' 'unsafe-eval'"
      const result = validateCsp(csp)
      expect(result.valid).toBe(false)
      expect(result.warnings).toContain(
        expect.stringContaining('unsafe-eval')
      )
    })

    it('should warn about unsafe-inline without nonce', () => {
      const csp = "script-src 'self' 'unsafe-inline'"
      const result = validateCsp(csp)
      expect(result.valid).toBe(false)
      expect(result.warnings).toContain(
        expect.stringContaining('unsafe-inline')
      )
    })

    it('should not warn about unsafe-inline with nonce', () => {
      const csp = "script-src 'self' 'unsafe-inline' 'nonce-abc123'"
      const result = validateCsp(csp)
      expect(result.warnings).not.toContain(
        expect.stringContaining('unsafe-inline')
      )
    })

    it('should warn about wildcard sources', () => {
      const csp = "script-src *"
      const result = validateCsp(csp)
      expect(result.valid).toBe(false)
      expect(result.warnings).toContain(
        expect.stringContaining('wildcard')
      )
    })

    it('should warn about missing script-src', () => {
      const csp = "default-src 'self'"
      const result = validateCsp(csp)
      expect(result.valid).toBe(false)
      expect(result.warnings).toContain(
        expect.stringContaining('script-src')
      )
    })

    it('should warn about missing default-src', () => {
      const csp = "script-src 'self'"
      const result = validateCsp(csp)
      expect(result.valid).toBe(false)
      expect(result.warnings).toContain(
        expect.stringContaining('default-src')
      )
    })

    it('should handle multiple warnings', () => {
      const csp = "script-src 'unsafe-eval' 'unsafe-inline'"
      const result = validateCsp(csp)
      expect(result.valid).toBe(false)
      expect(result.warnings.length).toBeGreaterThan(1)
    })
  })

  describe('Security Requirements', () => {
    const nonce = generateCspNonce()

    it('should deny all by default', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain("default-src 'none'")
    })

    it('should only allow nonce-based scripts', () => {
      const csp = buildWebviewCsp(nonce, { allowInlineStyles: false })
      expect(csp).toMatch(/script-src 'nonce-[^']+$/)
      expect(csp).not.toContain("'unsafe-eval'")
    })

    it('should block all objects/embeds', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain("object-src 'none'")
    })

    it('should block all frames', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain("frame-src 'none'")
    })

    it('should block all connections', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain("connect-src 'none'")
    })

    it('should block all form submissions', () => {
      const csp = buildWebviewCsp(nonce)
      expect(csp).toContain("form-action 'none'")
    })

    it('should validate skill detail CSP is secure', () => {
      const csp = getSkillDetailCsp(nonce)
      const validation = validateCsp(csp)

      // Should have script-src and default-src
      expect(validation.warnings).not.toContain(
        expect.stringContaining('missing script-src')
      )
      expect(validation.warnings).not.toContain(
        expect.stringContaining('missing default-src')
      )

      // Should not have wildcard
      expect(validation.warnings).not.toContain(
        expect.stringContaining('wildcard')
      )
    })
  })
})

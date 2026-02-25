/**
 * SMI-2756: Wave 3 — LanguageRouter tests
 *
 * Tests the LanguageRouter dispatch layer: adapter registration,
 * extension-based lookup, tryGetAdapter, canHandle, getLanguage,
 * getSupportedLanguages, framework rules aggregation, and dispose.
 */

import { describe, it, expect } from 'vitest'
import { LanguageRouter } from '../../src/analysis/router.js'

describe('LanguageRouter', () => {
  // -------------------------------------------------------------------------
  // createWithAllAdapters factory
  // -------------------------------------------------------------------------

  describe('createWithAllAdapters', () => {
    it('creates a router with multiple adapters pre-registered', () => {
      const router = LanguageRouter.createWithAllAdapters()
      expect(router.adapterCount).toBeGreaterThan(0)
    })

    it('creates a router with only specified languages', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['typescript'] })
      expect(router.getSupportedLanguages()).toContain('typescript')
      // Should have fewer adapters than the full set
      const fullRouter = LanguageRouter.createWithAllAdapters()
      expect(router.adapterCount).toBeLessThanOrEqual(fullRouter.adapterCount)
    })
  })

  // -------------------------------------------------------------------------
  // registerAdapter / unregisterAdapter
  // -------------------------------------------------------------------------

  describe('registerAdapter / unregisterAdapter', () => {
    it('registers an adapter and makes its extension routable', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['typescript'] })
      expect(router.canHandle('main.ts')).toBe(true)
    })

    it('unregisterAdapter removes extension mappings', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['typescript'] })
      expect(router.canHandle('main.ts')).toBe(true)

      const removed = router.unregisterAdapter('typescript')

      expect(removed).toBe(true)
      expect(router.canHandle('main.ts')).toBe(false)
    })

    it('unregisterAdapter returns false for unknown language', () => {
      const router = new LanguageRouter()
      const result = router.unregisterAdapter('typescript')
      expect(result).toBe(false)
    })

    it('re-registering an adapter replaces the old one', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['typescript'] })
      const before = router.adapterCount

      // Re-register the same language
      const tsAdapter = router.getAdapterByLanguage('typescript')!
      router.registerAdapter(tsAdapter)

      // Count should not grow
      expect(router.adapterCount).toBe(before)
    })
  })

  // -------------------------------------------------------------------------
  // getAdapter / tryGetAdapter / canHandle / getLanguage
  // -------------------------------------------------------------------------

  describe('getAdapter', () => {
    it('returns adapter for a known extension', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['typescript'] })
      const adapter = router.tryGetAdapter('main.ts')
      expect(adapter).not.toBeNull()
      expect(adapter?.language).toBe('typescript')
    })

    it('throws for unknown extension', () => {
      const router = new LanguageRouter()
      expect(() => router.getAdapter('unknown.xyz')).toThrow(/No adapter registered/)
    })

    it('tryGetAdapter returns null for unknown extension', () => {
      const router = new LanguageRouter()
      expect(router.tryGetAdapter('unknown.xyz')).toBeNull()
    })
  })

  describe('canHandle', () => {
    it('returns true for registered extension', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['python'] })
      expect(router.canHandle('app.py')).toBe(true)
    })

    it('returns false for unregistered extension', () => {
      const router = new LanguageRouter()
      expect(router.canHandle('app.cobol')).toBe(false)
    })
  })

  describe('getLanguage', () => {
    it('returns language for a known file path', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['python'] })
      expect(router.getLanguage('script.py')).toBe('python')
    })

    it('returns null for unsupported extension', () => {
      const router = new LanguageRouter()
      expect(router.getLanguage('file.cobol')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // getSupportedLanguages / getSupportedExtensions
  // -------------------------------------------------------------------------

  describe('getSupportedLanguages / getSupportedExtensions', () => {
    it('getSupportedLanguages returns registered language keys', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['typescript', 'python'] })
      const langs = router.getSupportedLanguages()
      expect(langs).toContain('typescript')
      expect(langs).toContain('python')
    })

    it('getSupportedExtensions includes dot-prefixed extensions', () => {
      const router = LanguageRouter.createWithAllAdapters({ languages: ['typescript'] })
      const exts = router.getSupportedExtensions()
      expect(exts.some((e) => e.startsWith('.'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // getAllFrameworkRules / getFrameworkRules
  // -------------------------------------------------------------------------

  describe('framework rules', () => {
    it('getAllFrameworkRules returns an array', () => {
      const router = LanguageRouter.createWithAllAdapters()
      const rules = router.getAllFrameworkRules()
      expect(Array.isArray(rules)).toBe(true)
    })

    it('getFrameworkRules returns empty array for unregistered language', () => {
      const router = new LanguageRouter()
      const rules = router.getFrameworkRules('typescript')
      expect(rules).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe('dispose', () => {
    it('clears adapter registry after dispose', () => {
      const router = LanguageRouter.createWithAllAdapters()
      expect(router.adapterCount).toBeGreaterThan(0)

      router.dispose()

      expect(router.adapterCount).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // detectLanguageFromContent (disabled)
  // -------------------------------------------------------------------------

  describe('detectLanguageFromContent', () => {
    it('returns language:null and method:none when detection is disabled', () => {
      const router = new LanguageRouter({ enableLanguageDetection: false })
      const result = router.detectLanguageFromContent('#!/usr/bin/env python3\nprint("hello")')
      expect(result.language).toBeNull()
      expect(result.method).toBe('none')
    })
  })
})

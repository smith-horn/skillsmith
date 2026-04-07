/**
 * @fileoverview Tests for SSO configuration MCP tools
 * @see SMI-3900: SSO/SAML Configuration MCP Tools
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  configureSsoInputSchema,
  ssoSettingsInputSchema,
  executeConfigureSso,
  executeSsoSettings,
  createStubSSOService,
  setSSOConfigService,
  type ConfigureSsoInput,
  type SsoSettingsInput,
} from './sso-tools.js'

const mockContext = {} as ToolContext

describe('sso-tools', () => {
  beforeEach(() => {
    // Reset to fresh stub service before each test
    setSSOConfigService(createStubSSOService())
  })

  // ==========================================================================
  // Schema validation
  // ==========================================================================

  describe('configureSsoInputSchema', () => {
    it('should accept valid set input', () => {
      const input = {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        protocol: 'saml',
      }
      expect(configureSsoInputSchema.parse(input)).toMatchObject({
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        protocol: 'saml',
      })
    })

    it('should default protocol to saml', () => {
      const input = { action: 'test' }
      const parsed = configureSsoInputSchema.parse(input)
      expect(parsed.protocol).toBe('saml')
    })

    it('should reject invalid action', () => {
      expect(() => configureSsoInputSchema.parse({ action: 'invalid' })).toThrow()
    })

    it('should reject invalid URL', () => {
      expect(() =>
        configureSsoInputSchema.parse({ action: 'set', idpMetadataUrl: 'not-a-url' })
      ).toThrow()
    })

    it('should accept oidc protocol', () => {
      const input = {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/.well-known/openid-configuration',
        protocol: 'oidc',
      }
      const parsed = configureSsoInputSchema.parse(input)
      expect(parsed.protocol).toBe('oidc')
    })
  })

  describe('ssoSettingsInputSchema', () => {
    it('should accept empty object', () => {
      const parsed = ssoSettingsInputSchema.parse({})
      expect(parsed.includeMetadata).toBe(false)
    })

    it('should accept includeMetadata flag', () => {
      const parsed = ssoSettingsInputSchema.parse({ includeMetadata: true })
      expect(parsed.includeMetadata).toBe(true)
    })
  })

  // ==========================================================================
  // configure_sso handler
  // ==========================================================================

  describe('executeConfigureSso', () => {
    it('should set SSO config', async () => {
      const input: ConfigureSsoInput = {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        protocol: 'saml',
      }
      const result = await executeConfigureSso(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.config).toBeDefined()
      expect(result.config!.protocol).toBe('saml')
      expect(result.config!.idpMetadataUrl).toBe('https://idp.example.com/metadata')
      expect(result.config!.status).toBe('active')
      expect(result.message).toContain('SSO configured')
    })

    it('should set SSO config with explicit entity ID', async () => {
      const input: ConfigureSsoInput = {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        idpEntityId: 'https://custom-entity.example.com',
        protocol: 'saml',
      }
      const result = await executeConfigureSso(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.config!.idpEntityId).toBe('https://custom-entity.example.com')
    })

    it('should fail set without metadata URL', async () => {
      const input: ConfigureSsoInput = { action: 'set', protocol: 'saml' }
      const result = await executeConfigureSso(input, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('idpMetadataUrl is required')
    })

    it('should test SSO connection after config set', async () => {
      // First set config
      await executeConfigureSso(
        {
          action: 'set',
          idpMetadataUrl: 'https://idp.example.com/metadata',
          protocol: 'saml',
        },
        mockContext
      )

      // Then test
      const result = await executeConfigureSso({ action: 'test', protocol: 'saml' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.test).toBeDefined()
      expect(result.test!.success).toBe(true)
      expect(result.test!.latencyMs).toBeGreaterThan(0)
    })

    it('should fail test without prior config', async () => {
      const result = await executeConfigureSso({ action: 'test', protocol: 'saml' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.message).toContain('No SSO configuration found')
    })

    it('should remove SSO config', async () => {
      // Set config first
      await executeConfigureSso(
        {
          action: 'set',
          idpMetadataUrl: 'https://idp.example.com/metadata',
          protocol: 'saml',
        },
        mockContext
      )

      // Remove
      const result = await executeConfigureSso({ action: 'remove', protocol: 'saml' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.message).toContain('removed')
    })

    it('should fail remove when no config exists', async () => {
      const result = await executeConfigureSso({ action: 'remove', protocol: 'saml' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('No SSO configuration')
    })
  })

  // ==========================================================================
  // sso_settings handler
  // ==========================================================================

  describe('executeSsoSettings', () => {
    it('should return not configured when no SSO set', async () => {
      const input: SsoSettingsInput = { includeMetadata: false }
      const result = await executeSsoSettings(input, mockContext)
      expect(result.configured).toBe(false)
      expect(result.config).toBeUndefined()
      expect(result.message).toContain('No SSO configuration found')
    })

    it('should return config after SSO is set', async () => {
      await executeConfigureSso(
        {
          action: 'set',
          idpMetadataUrl: 'https://idp.example.com/metadata',
          protocol: 'saml',
        },
        mockContext
      )

      const result = await executeSsoSettings({ includeMetadata: false }, mockContext)
      expect(result.configured).toBe(true)
      expect(result.config).toBeDefined()
      expect(result.config!.protocol).toBe('saml')
      expect(result.message).toContain('SSO is configured')
    })

    it('should include metadata when requested', async () => {
      await executeConfigureSso(
        {
          action: 'set',
          idpMetadataUrl: 'https://idp.example.com/metadata',
          protocol: 'oidc',
        },
        mockContext
      )

      const result = await executeSsoSettings({ includeMetadata: true }, mockContext)
      expect(result.configured).toBe(true)
      expect(result.config!.idpMetadataUrl).toBe('https://idp.example.com/metadata')
    })
  })
})

/**
 * Config.json Schema Validation Tests - SMI-3870
 */

import { describe, it, expect } from 'vitest'
import { validateSkillConfig, SkillConfigSchema } from '../../src/services/skill-config-schema.js'

describe('validateSkillConfig', () => {
  it('accepts valid config with all fields', () => {
    const config = JSON.stringify({
      displayName: 'My Skill',
      version: '1.0.0',
      presets: { theme: 'dark', maxRetries: 3, verbose: true },
      settings: { timeout: 5000, debug: false },
      mcpServers: ['server-a', 'server-b'],
      minClaudeCodeVersion: '1.2.0',
    })
    const result = validateSkillConfig(config)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.config).toBeDefined()
  })

  it('accepts empty object (all fields optional)', () => {
    const result = validateSkillConfig('{}')
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects invalid JSON', () => {
    const result = validateSkillConfig('not json at all')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Invalid JSON')
  })

  it('rejects oversized displayName', () => {
    const config = JSON.stringify({ displayName: 'x'.repeat(101) })
    const result = validateSkillConfig(config)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rejects oversized version', () => {
    const config = JSON.stringify({ version: 'v'.repeat(21) })
    const result = validateSkillConfig(config)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rejects too many mcpServers', () => {
    const servers = Array.from({ length: 11 }, (_, i) => 'server-' + i)
    const config = JSON.stringify({ mcpServers: servers })
    const result = validateSkillConfig(config)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rejects non-primitive preset values', () => {
    const config = JSON.stringify({ presets: { nested: { a: 1 } } })
    const result = validateSkillConfig(config)
    expect(result.valid).toBe(false)
  })

  it('rejects non-primitive settings values', () => {
    const config = JSON.stringify({ settings: { arr: [1, 2, 3] } })
    const result = validateSkillConfig(config)
    expect(result.valid).toBe(false)
  })

  it('warns about unknown keys (passthrough mode)', () => {
    const config = JSON.stringify({
      displayName: 'Test',
      customField: 'hello',
      anotherUnknown: 42,
    })
    const result = validateSkillConfig(config)
    expect(result.valid).toBe(true)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('unknown keys')
    expect(result.warnings[0]).toContain('customField')
    expect(result.warnings[0]).toContain('anotherUnknown')
  })

  it('returns no warnings when only known keys are present', () => {
    const config = JSON.stringify({ displayName: 'Test', version: '1.0' })
    const result = validateSkillConfig(config)
    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual([])
  })
})

describe('SkillConfigSchema', () => {
  it('accepts primitive preset values (string, number, boolean)', () => {
    const data = { presets: { name: 'foo', count: 42, enabled: true } }
    const result = SkillConfigSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it('rejects array preset values', () => {
    const data = { presets: { items: [1, 2, 3] } }
    const result = SkillConfigSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it('rejects object preset values', () => {
    const data = { presets: { nested: { key: 'val' } } }
    const result = SkillConfigSchema.safeParse(data)
    expect(result.success).toBe(false)
  })
})

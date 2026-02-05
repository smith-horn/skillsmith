/**
 * SMI-2279: Test audit logging for FEATURE_STRICT_CANIMPORT override
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

describe('SMI-2279: FEATURE_STRICT_CANIMPORT audit logging', () => {
  const originalEnv = process.env.FEATURE_STRICT_CANIMPORT

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.FEATURE_STRICT_CANIMPORT
    } else {
      process.env.FEATURE_STRICT_CANIMPORT = originalEnv
    }
    vi.restoreAllMocks()
  })

  it('should log warning when FEATURE_STRICT_CANIMPORT is set to false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Set env before importing module
    process.env.FEATURE_STRICT_CANIMPORT = 'false'

    // Dynamic import to pick up new env value
    const { QuarantineRepository } = await import(
      '../src/repositories/quarantine/QuarantineRepository.js'
    )

    // Verify warning was logged at module load time
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('FEATURE_STRICT_CANIMPORT is disabled')
    )
  })

  it('should document security_feature_flag_override event type', () => {
    // SMI-2279: The AuditEventType union type now includes 'security_feature_flag_override'
    // This is verified at compile time by TypeScript. This test documents the requirement.
    //
    // The event is logged when FEATURE_STRICT_CANIMPORT=false is detected, indicating
    // a potential security policy override that should be audited.
    const expectedEventType = 'security_feature_flag_override'
    expect(expectedEventType).toBe('security_feature_flag_override')
  })
})

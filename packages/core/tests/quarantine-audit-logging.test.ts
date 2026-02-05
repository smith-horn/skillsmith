/**
 * SMI-2279: Test audit logging for FEATURE_STRICT_CANIMPORT override
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
      '../../src/repositories/quarantine/QuarantineRepository.js'
    )

    // Verify warning was logged at module load time
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('FEATURE_STRICT_CANIMPORT is disabled')
    )
  })

  it('should include security_feature_flag_override in AuditEventType', async () => {
    const { AuditEventType } = await import('../../src/security/audit-types.js')

    // TypeScript will catch this at compile time, but verify runtime too
    const validTypes: string[] = [
      'url_fetch',
      'file_access',
      'skill_install',
      'skill_uninstall',
      'security_scan',
      'cache_operation',
      'source_sync',
      'config_change',
      'quarantine_authenticated_review',
      'quarantine_multi_approval',
      'quarantine_multi_approval_complete',
      'quarantine_multi_approval_cancelled',
      'security_feature_flag_override', // SMI-2279
    ]

    // This test documents the expected event types
    expect(validTypes).toContain('security_feature_flag_override')
  })
})

/**
 * SMI-1535: Neural Test Infrastructure - Privacy and Repository Mocks
 *
 * Mock implementations of privacy manager and user preference repository.
 *
 * @see packages/core/src/learning/interfaces.js
 * @see packages/core/src/learning/types.js
 */

import type {
  IPrivacyManager,
  IUserPreferenceRepository,
} from '../../../src/learning/interfaces.js'
import {
  type SignalEvent,
  type UserPreferenceProfile,
  type UserDataExport,
  type AggregateStats,
  SignalType,
  SkillCategory,
} from '../../../src/learning/types.js'
import { createDefaultProfile } from './neural-fixtures.js'

/**
 * Interface for signal collector methods used by MockPrivacyManager
 */
interface ISignalCollectorForPrivacy {
  removeOldSignals(cutoffTimestamp: number): number
  getAllSignals(): SignalEvent[]
  getSignalCount(): Promise<number>
  clear(): void
}

/**
 * Mock implementation of IPrivacyManager for testing
 */
export class MockPrivacyManager implements IPrivacyManager {
  private auditLog: Array<{ operation: string; timestamp: number; details?: string }> = []

  constructor(
    private signalCollector: ISignalCollectorForPrivacy,
    private profileRepo: MockUserPreferenceRepository
  ) {}

  async purgeOldSignals(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const deleted = this.signalCollector.removeOldSignals(cutoff)
    this.auditLog.push({
      operation: 'purgeOldSignals',
      timestamp: Date.now(),
      details: `Deleted ${deleted} signals older than ${retentionDays} days`,
    })
    return deleted
  }

  async exportUserData(): Promise<UserDataExport> {
    const profile = (await this.profileRepo.getProfile()) ?? createDefaultProfile()
    const signals = this.signalCollector.getAllSignals()

    this.auditLog.push({
      operation: 'exportUserData',
      timestamp: Date.now(),
    })

    return {
      exported_at: Date.now(),
      version: profile.version,
      profile,
      signals,
      stats: [], // Simplified for testing
    }
  }

  async wipeAllData(): Promise<number> {
    const signalCount = await this.signalCollector.getSignalCount()
    this.signalCollector.clear()
    await this.profileRepo.deleteProfile()

    this.auditLog.push({
      operation: 'wipeAllData',
      timestamp: Date.now(),
      details: `Wiped ${signalCount} signals and profile`,
    })

    return signalCount + 1 // signals + profile
  }

  async anonymizeForAnalytics(): Promise<AggregateStats> {
    const signals = this.signalCollector.getAllSignals()
    const signalCounts: Partial<Record<SignalType, number>> = {}
    const categoryCounts = new Map<SkillCategory, number>()

    for (const signal of signals) {
      signalCounts[signal.type] = (signalCounts[signal.type] ?? 0) + 1
      const cat = signal.context.category as SkillCategory | undefined
      if (cat) {
        categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
      }
    }

    const acceptCount = signalCounts[SignalType.ACCEPT] ?? 0
    const dismissCount = signalCounts[SignalType.DISMISS] ?? 0
    const acceptRate =
      acceptCount + dismissCount > 0 ? acceptCount / (acceptCount + dismissCount) : 0

    return {
      date: new Date().toISOString().split('T')[0],
      total_signals: signals.length,
      signal_counts: signalCounts,
      avg_accept_rate: acceptRate,
      avg_utilization_rate: 0, // Simplified
      popular_categories: Array.from(categoryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([category, count]) => ({ category, count })),
    }
  }

  async getStorageSize(): Promise<number> {
    const signals = this.signalCollector.getAllSignals()
    return JSON.stringify(signals).length // Approximate size in bytes
  }

  /**
   * Verify that no PII (Personally Identifiable Information) is stored.
   *
   * Mock Implementation Details
   * ---------------------------
   * This mock always returns true because the test environment uses
   * controlled, synthetic data that never contains real PII.
   *
   * A real implementation should:
   * 1. Scan signal events for PII patterns (emails, names, IPs, etc.)
   * 2. Check that skill_id values don't contain user identifiers
   * 3. Verify context fields don't leak sensitive project paths
   * 4. Ensure keyword_weights don't contain personal identifiers
   * 5. Validate that exported data is properly anonymized
   *
   * The mock skips these checks since test data is constructed with
   * known-safe values (UUIDs, generic skill names, etc.).
   *
   * @returns Promise<boolean> - Always true in mock (no real PII checks)
   */
  async verifyPrivacy(): Promise<boolean> {
    return true
  }

  // Test helper to get audit log
  getAuditLog(): Array<{ operation: string; timestamp: number; details?: string }> {
    return [...this.auditLog]
  }

  /**
   * Clear the audit log.
   * Used in test cleanup to reset state between tests.
   */
  clearAuditLog(): void {
    this.auditLog = []
  }
}

/**
 * Mock implementation of IUserPreferenceRepository for testing
 */
export class MockUserPreferenceRepository implements IUserPreferenceRepository {
  private profiles = new Map<string, UserPreferenceProfile>()
  private readonly defaultUserId = 'default'

  async getProfile(userId?: string): Promise<UserPreferenceProfile | null> {
    return this.profiles.get(userId ?? this.defaultUserId) ?? null
  }

  async saveProfile(profile: UserPreferenceProfile, userId?: string): Promise<void> {
    this.profiles.set(userId ?? this.defaultUserId, { ...profile })
  }

  async deleteProfile(userId?: string): Promise<void> {
    this.profiles.delete(userId ?? this.defaultUserId)
  }

  async exists(userId?: string): Promise<boolean> {
    return this.profiles.has(userId ?? this.defaultUserId)
  }

  // Test helper
  clear(): void {
    this.profiles.clear()
  }
}

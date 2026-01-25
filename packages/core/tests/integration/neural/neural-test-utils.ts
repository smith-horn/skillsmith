/**
 * SMI-1535: Neural Test Infrastructure - Test Utilities
 *
 * Utilities for creating and cleaning up neural test contexts.
 *
 * @see packages/core/src/learning/interfaces.ts
 */

import {
  MockSignalCollector,
  MockPreferenceLearner,
  MockPersonalizationEngine,
  MockPrivacyManager,
  MockUserPreferenceRepository,
} from './neural-mocks.js'

/**
 * Neural test context containing all mock service instances
 */
export interface NeuralTestContext {
  signalCollector: MockSignalCollector
  preferenceLearner: MockPreferenceLearner
  personalizationEngine: MockPersonalizationEngine
  privacyManager: MockPrivacyManager
  profileRepository: MockUserPreferenceRepository
}

/**
 * Create a fresh neural test context with all mock services
 */
export function createNeuralTestContext(): NeuralTestContext {
  const profileRepository = new MockUserPreferenceRepository()
  const signalCollector = new MockSignalCollector()
  const preferenceLearner = new MockPreferenceLearner()
  const personalizationEngine = new MockPersonalizationEngine(
    preferenceLearner,
    profileRepository,
    signalCollector
  )
  const privacyManager = new MockPrivacyManager(signalCollector, profileRepository)

  return {
    signalCollector,
    preferenceLearner,
    personalizationEngine,
    privacyManager,
    profileRepository,
  }
}

/**
 * Clean up a neural test context (release resources)
 */
export async function cleanupNeuralTestContext(ctx: NeuralTestContext): Promise<void> {
  // Clear all stored data
  ctx.signalCollector.clear()
  ctx.profileRepository.clear()
  ctx.privacyManager.clearAuditLog()
}

/**
 * SMI-1535: Neural Test Infrastructure - Setup
 *
 * Provides test context factory and mock implementations for
 * the Recommendation Learning Loop integration tests.
 *
 * This file re-exports all neural test infrastructure from
 * modular files for backwards compatibility.
 *
 * @see packages/core/src/learning/interfaces.ts
 * @see packages/core/src/learning/types.ts
 */

// Re-export fixtures
export { createDefaultProfile } from './neural-fixtures.js'

// Re-export test utilities
export {
  type NeuralTestContext,
  createNeuralTestContext,
  cleanupNeuralTestContext,
} from './neural-test-utils.js'

// Re-export mock implementations
export {
  MockSignalCollector,
  MockPreferenceLearner,
  MockPersonalizationEngine,
  MockPrivacyManager,
  MockUserPreferenceRepository,
} from './neural-mocks.js'

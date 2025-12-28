/**
 * SMI-638: Session Checkpointing Module
 *
 * Provides session state persistence through checkpoint management,
 * integrated with claude-flow memory hooks for cross-session continuity.
 *
 * @module session
 */

// Checkpoint data structure and serialization
export {
  SessionCheckpoint,
  generateCheckpointId,
  generateSessionId,
  type SessionCheckpointData,
  type FileModification,
  type TestResult,
  type CheckpointTodo,
  type TodoStatus,
} from './SessionCheckpoint.js'

// Checkpoint manager with auto-save
export {
  CheckpointManager,
  type CheckpointManagerOptions,
  type MemoryOperationResult,
} from './CheckpointManager.js'

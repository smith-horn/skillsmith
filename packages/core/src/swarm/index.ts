/**
 * Swarm Coordination Module
 * SMI-634: Swarm Coordination Improvements
 *
 * Provides multi-agent orchestration capabilities for parallel development sessions.
 */

// Agent State Management
export {
  AgentState,
  type AgentStateData,
  type AgentStatus,
  type AgentType,
  type FileModification,
  type TaskAssignment,
} from './AgentState.js'

// Task Queue Management
export {
  TaskQueue,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
  type TaskCallback,
} from './TaskQueue.js'

// Swarm Coordinator
export {
  SwarmCoordinator,
  type AgentRegistration,
  type CoordinatorConfig,
  type FileConflict,
  type LoadBalanceStrategy,
  type SwarmProgress,
} from './SwarmCoordinator.js'

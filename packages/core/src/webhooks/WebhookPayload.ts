/**
 * SMI-645: WebhookPayload - GitHub webhook payload types
 *
 * Provides:
 * - GitHub webhook payload type definitions
 * - Push event parsing utilities
 * - Repository event parsing utilities
 * - Signature verification types
 *
 * SMI-680: Added zod schema validation for security
 */

import { PushEventSchema, RepositoryEventSchema, PingEventSchema } from './webhook-schemas.js'

import type { PushEventPayload, RepositoryEventPayload, PingEventPayload } from './webhook-types.js'

// Re-export types for backward compatibility
export type {
  WebhookEventType,
  RepositoryAction,
  GitUser,
  PushCommit,
  RepositoryOwner,
  WebhookRepository,
  WebhookSender,
  PushEventPayload,
  RepositoryEventPayload,
  PingEventPayload,
  WebhookPayload,
  ParsedWebhookEvent,
  SignatureVerificationResult,
  SkillFileChange,
} from './webhook-types.js'

/**
 * Check if a file path is a SKILL.md file
 */
export function isSkillFile(filePath: string): boolean {
  // Match SKILL.md anywhere in the path
  // Common locations: .claude/skills/name/SKILL.md, skills/name/SKILL.md, SKILL.md
  const normalizedPath = filePath.toLowerCase()
  return normalizedPath.endsWith('skill.md')
}

/**
 * Extract SKILL.md changes from a push event
 */
export function extractSkillChanges(
  payload: PushEventPayload
): import('./webhook-types.js').SkillFileChange[] {
  const changes: import('./webhook-types.js').SkillFileChange[] = []

  // Skip if this is a branch deletion
  if (payload.deleted) {
    return changes
  }

  // Only process pushes to the default branch
  const pushBranch = payload.ref.replace('refs/heads/', '')
  if (pushBranch !== payload.repository.default_branch) {
    return changes
  }

  for (const commit of payload.commits) {
    // Process added files
    for (const filePath of commit.added) {
      if (isSkillFile(filePath)) {
        changes.push({
          changeType: 'added',
          filePath,
          repoFullName: payload.repository.full_name,
          repoUrl: payload.repository.html_url,
          commitSha: commit.id,
          commitMessage: commit.message,
          defaultBranch: payload.repository.default_branch,
          owner: payload.repository.owner.login,
          repoName: payload.repository.name,
          timestamp: commit.timestamp,
        })
      }
    }

    // Process modified files
    for (const filePath of commit.modified) {
      if (isSkillFile(filePath)) {
        changes.push({
          changeType: 'modified',
          filePath,
          repoFullName: payload.repository.full_name,
          repoUrl: payload.repository.html_url,
          commitSha: commit.id,
          commitMessage: commit.message,
          defaultBranch: payload.repository.default_branch,
          owner: payload.repository.owner.login,
          repoName: payload.repository.name,
          timestamp: commit.timestamp,
        })
      }
    }

    // Process removed files
    for (const filePath of commit.removed) {
      if (isSkillFile(filePath)) {
        changes.push({
          changeType: 'removed',
          filePath,
          repoFullName: payload.repository.full_name,
          repoUrl: payload.repository.html_url,
          commitSha: commit.id,
          commitMessage: commit.message,
          defaultBranch: payload.repository.default_branch,
          owner: payload.repository.owner.login,
          repoName: payload.repository.name,
          timestamp: commit.timestamp,
        })
      }
    }
  }

  return changes
}

/**
 * Parse a raw webhook payload into a typed event
 * SMI-680: Now uses zod schemas for secure validation
 */
export function parseWebhookPayload(
  eventType: string,
  payload: unknown
): import('./webhook-types.js').ParsedWebhookEvent {
  switch (eventType) {
    case 'push': {
      const result = PushEventSchema.safeParse(payload)
      if (!result.success) {
        throw new Error(`Invalid push event payload: ${result.error.message}`)
      }
      // Cast through unknown to satisfy TypeScript since passthrough adds index signature
      return { type: 'push', payload: result.data as unknown as PushEventPayload }
    }
    case 'repository': {
      const result = RepositoryEventSchema.safeParse(payload)
      if (!result.success) {
        throw new Error(`Invalid repository event payload: ${result.error.message}`)
      }
      return { type: 'repository', payload: result.data as unknown as RepositoryEventPayload }
    }
    case 'ping': {
      const result = PingEventSchema.safeParse(payload)
      if (!result.success) {
        throw new Error(`Invalid ping event payload: ${result.error.message}`)
      }
      return { type: 'ping', payload: result.data as unknown as PingEventPayload }
    }
    default:
      return { type: 'unknown', payload }
  }
}

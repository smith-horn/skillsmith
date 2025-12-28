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

import { z } from 'zod'

/**
 * GitHub webhook event types we handle
 */
export type WebhookEventType = 'push' | 'repository' | 'ping'

/**
 * Repository action types
 */
export type RepositoryAction =
  | 'created'
  | 'deleted'
  | 'archived'
  | 'unarchived'
  | 'publicized'
  | 'privatized'
  | 'renamed'
  | 'transferred'

/**
 * Git commit author/committer
 */
export interface GitUser {
  name: string
  email: string
  username?: string
}

/**
 * A single commit in a push event
 */
export interface PushCommit {
  id: string
  tree_id: string
  distinct: boolean
  message: string
  timestamp: string
  url: string
  author: GitUser
  committer: GitUser
  added: string[]
  removed: string[]
  modified: string[]
}

/**
 * Repository owner (user or organization)
 */
export interface RepositoryOwner {
  login: string
  id: number
  type: 'User' | 'Organization'
  avatar_url?: string
  html_url?: string
}

/**
 * Repository information in webhook payloads
 */
export interface WebhookRepository {
  id: number
  name: string
  full_name: string
  private: boolean
  owner: RepositoryOwner
  html_url: string
  description: string | null
  fork: boolean
  url: string
  created_at: string | number
  updated_at: string
  pushed_at: string | number
  homepage: string | null
  size: number
  stargazers_count: number
  watchers_count: number
  language: string | null
  forks_count: number
  archived: boolean
  disabled: boolean
  open_issues_count: number
  topics: string[]
  visibility: 'public' | 'private' | 'internal'
  default_branch: string
}

/**
 * Sender information (who triggered the event)
 */
export interface WebhookSender {
  login: string
  id: number
  type: 'User' | 'Organization' | 'Bot'
  avatar_url?: string
  html_url?: string
}

/**
 * Push event payload
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
 */
export interface PushEventPayload {
  ref: string
  before: string
  after: string
  created: boolean
  deleted: boolean
  forced: boolean
  base_ref: string | null
  compare: string
  commits: PushCommit[]
  head_commit: PushCommit | null
  repository: WebhookRepository
  pusher: GitUser
  sender: WebhookSender
}

/**
 * Repository event payload
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository
 */
export interface RepositoryEventPayload {
  action: RepositoryAction
  repository: WebhookRepository
  sender: WebhookSender
  changes?: {
    owner?: {
      from: RepositoryOwner
    }
    repository?: {
      name: {
        from: string
      }
    }
  }
}

/**
 * Ping event payload (sent when webhook is first configured)
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#ping
 */
export interface PingEventPayload {
  zen: string
  hook_id: number
  hook: {
    type: string
    id: number
    name: string
    active: boolean
    events: string[]
    config: {
      content_type: string
      insecure_ssl: string
      url: string
    }
  }
  repository?: WebhookRepository
  sender: WebhookSender
}

/**
 * Union type of all webhook payloads we handle
 */
export type WebhookPayload = PushEventPayload | RepositoryEventPayload | PingEventPayload

/**
 * Parsed webhook event with type discrimination
 */
export type ParsedWebhookEvent =
  | { type: 'push'; payload: PushEventPayload }
  | { type: 'repository'; payload: RepositoryEventPayload }
  | { type: 'ping'; payload: PingEventPayload }
  | { type: 'unknown'; payload: unknown }

/**
 * Signature verification result
 */
export interface SignatureVerificationResult {
  valid: boolean
  error?: string
}

/**
 * SKILL.md change detected in a push event
 */
export interface SkillFileChange {
  /**
   * Type of change: added, modified, or removed
   */
  changeType: 'added' | 'modified' | 'removed'

  /**
   * Full path to the SKILL.md file (e.g., ".claude/skills/my-skill/SKILL.md")
   */
  filePath: string

  /**
   * Repository full name (e.g., "owner/repo")
   */
  repoFullName: string

  /**
   * Repository URL
   */
  repoUrl: string

  /**
   * Commit SHA that made the change
   */
  commitSha: string

  /**
   * Commit message
   */
  commitMessage: string

  /**
   * Repository default branch
   */
  defaultBranch: string

  /**
   * Repository owner
   */
  owner: string

  /**
   * Repository name
   */
  repoName: string

  /**
   * Timestamp of the change
   */
  timestamp: string
}

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
export function extractSkillChanges(payload: PushEventPayload): SkillFileChange[] {
  const changes: SkillFileChange[] = []

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

// =============================================================================
// SMI-680: Zod Schemas for secure payload validation
// =============================================================================

/**
 * Git user schema (author/committer)
 */
const GitUserSchema = z
  .object({
    name: z.string(),
    email: z.string(),
    username: z.string().optional(),
  })
  .passthrough()

/**
 * Repository owner schema
 */
const RepositoryOwnerSchema = z
  .object({
    login: z.string(),
    id: z.number(),
    type: z.enum(['User', 'Organization']),
    avatar_url: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough()

/**
 * Webhook repository schema - minimum required fields
 */
const WebhookRepositorySchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    full_name: z.string(),
    private: z.boolean().optional(),
    owner: RepositoryOwnerSchema.optional(),
    html_url: z.string().optional(),
    default_branch: z.string(),
  })
  .passthrough()

/**
 * Push commit schema
 */
const PushCommitSchema = z
  .object({
    id: z.string(),
    message: z.string(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
    modified: z.array(z.string()),
  })
  .passthrough()

/**
 * Push event payload schema
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
 */
const PushEventSchema = z
  .object({
    ref: z.string(),
    before: z.string(),
    after: z.string(),
    repository: WebhookRepositorySchema,
    commits: z.array(PushCommitSchema).optional(),
  })
  .passthrough()

/**
 * Webhook sender schema
 */
const WebhookSenderSchema = z
  .object({
    login: z.string(),
    id: z.number(),
    type: z.enum(['User', 'Organization', 'Bot']),
  })
  .passthrough()

/**
 * Repository event payload schema
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository
 */
const RepositoryEventSchema = z
  .object({
    action: z.string(),
    repository: WebhookRepositorySchema,
    sender: WebhookSenderSchema.optional(),
  })
  .passthrough()

/**
 * Webhook hook config schema
 */
const WebhookHookConfigSchema = z
  .object({
    content_type: z.string(),
    insecure_ssl: z.string(),
    url: z.string(),
  })
  .passthrough()

/**
 * Webhook hook schema
 */
const WebhookHookSchema = z
  .object({
    type: z.string(),
    id: z.number(),
    name: z.string(),
    active: z.boolean(),
    events: z.array(z.string()),
    config: WebhookHookConfigSchema,
  })
  .passthrough()

/**
 * Ping event payload schema
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#ping
 */
const PingEventSchema = z
  .object({
    zen: z.string(),
    hook_id: z.number(),
    hook: WebhookHookSchema,
    repository: WebhookRepositorySchema.optional(),
    sender: WebhookSenderSchema.optional(),
  })
  .passthrough()

/**
 * Parse a raw webhook payload into a typed event
 * SMI-680: Now uses zod schemas for secure validation
 */
export function parseWebhookPayload(eventType: string, payload: unknown): ParsedWebhookEvent {
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

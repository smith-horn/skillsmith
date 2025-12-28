/**
 * SMI-645: WebhookPayload - GitHub webhook payload types
 *
 * Provides:
 * - GitHub webhook payload type definitions
 * - Push event parsing utilities
 * - Repository event parsing utilities
 * - Signature verification types
 */

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

/**
 * Parse a raw webhook payload into a typed event
 */
export function parseWebhookPayload(eventType: string, payload: unknown): ParsedWebhookEvent {
  switch (eventType) {
    case 'push':
      return { type: 'push', payload: payload as PushEventPayload }
    case 'repository':
      return { type: 'repository', payload: payload as RepositoryEventPayload }
    case 'ping':
      return { type: 'ping', payload: payload as PingEventPayload }
    default:
      return { type: 'unknown', payload }
  }
}

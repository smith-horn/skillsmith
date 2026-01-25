/**
 * SMI-645: Webhook Schemas - Zod validation schemas for GitHub webhooks
 *
 * SMI-680: Extracted from WebhookPayload.ts to reduce file size.
 *
 * Provides secure payload validation using Zod schemas.
 *
 * @see WebhookPayload.ts for type definitions and helper functions
 */

import { z } from 'zod'

// =============================================================================
// SMI-680: Zod Schemas for secure payload validation
// =============================================================================

/**
 * Git user schema (author/committer)
 */
export const GitUserSchema = z
  .object({
    name: z.string(),
    email: z.string(),
    username: z.string().optional(),
  })
  .passthrough()

/**
 * Repository owner schema
 */
export const RepositoryOwnerSchema = z
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
export const WebhookRepositorySchema = z
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
export const PushCommitSchema = z
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
export const PushEventSchema = z
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
export const WebhookSenderSchema = z
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
export const RepositoryEventSchema = z
  .object({
    action: z.string(),
    repository: WebhookRepositorySchema,
    sender: WebhookSenderSchema.optional(),
  })
  .passthrough()

/**
 * Webhook hook config schema
 */
export const WebhookHookConfigSchema = z
  .object({
    content_type: z.string(),
    insecure_ssl: z.string(),
    url: z.string(),
  })
  .passthrough()

/**
 * Webhook hook schema
 */
export const WebhookHookSchema = z
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
export const PingEventSchema = z
  .object({
    zen: z.string(),
    hook_id: z.number(),
    hook: WebhookHookSchema,
    repository: WebhookRepositorySchema.optional(),
    sender: WebhookSenderSchema.optional(),
  })
  .passthrough()

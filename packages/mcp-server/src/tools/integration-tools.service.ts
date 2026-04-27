/**
 * @fileoverview Real IntegrationService backed by Supabase
 * @module @skillsmith/mcp-server/tools/integration-tools.service
 * @see SMI-3915: Wave 1 — Webhooks + API Keys (Real Implementation)
 *
 * Uses HMAC-SHA256 for webhook signing. API keys are hashed with SHA-256
 * before storage — raw key is returned once on creation and never persisted.
 *
 * SSRF protection via validateExternalUrl() on all outbound URLs.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { validateExternalUrl } from '../utils/url-validator.js'
import type { IntegrationService, WebhookMasked, ApiKeyMasked } from './integration-tools.js'

// ============================================================================
// Supabase client type (avoid hard dependency on @supabase/supabase-js)
// ============================================================================

/** Minimal Supabase client interface for query building */
export interface SupabaseClient {
  from(table: string): SupabaseQueryBuilder
  rpc(fn: string, params?: Record<string, unknown>): Promise<SupabaseSingleResult>
}

interface SupabaseQueryBuilder {
  insert(row: Record<string, unknown>): SupabaseQueryBuilder
  update(row: Record<string, unknown>): SupabaseQueryBuilder
  delete(): SupabaseQueryBuilder
  select(columns?: string): SupabaseQueryBuilder
  eq(column: string, value: unknown): SupabaseQueryBuilder
  is(column: string, value: null): SupabaseQueryBuilder
  order(column: string, options?: { ascending?: boolean }): SupabaseQueryBuilder
  single(): Promise<SupabaseSingleResult>
  then(resolve: (value: SupabaseListResult) => void): void
}

interface SupabaseSingleResult {
  data: Record<string, unknown> | null
  error: { message: string } | null
}

interface SupabaseListResult {
  data: Record<string, unknown>[] | null
  error: { message: string } | null
}

// ============================================================================
// Constants
// ============================================================================

const TEST_RATE_LIMIT_MS = 60_000
const TEST_DELIVERY_TIMEOUT_MS = 10_000
const API_KEY_PREFIX_LENGTH = 15 // "sk_int_" (7) + 8 chars

// ============================================================================
// Crypto helpers
// ============================================================================

/**
 * HMAC key for hashing integration API keys. Read from
 * `SKILLSMITH_API_KEY_HMAC_SECRET` at first use (lazy so process.env writes from
 * the test harness or boot-time loaders apply). Replaces a previously
 * hardcoded constant (CodeQL js/insufficient-password-hash, CWE-916) — a known
 * static key meant a leaked api_keys table could be reverse-cracked offline.
 *
 * Must be the same value across every MCP host that creates or verifies
 * integration API keys; threat model + distribution channel matches
 * SUPABASE_SERVICE_ROLE_KEY (only Team+ admins touching the integrations
 * surface need it).
 */
function getKeyHmacSecret(): string {
  const secret = process.env.SKILLSMITH_API_KEY_HMAC_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'SKILLSMITH_API_KEY_HMAC_SECRET must be set to a 32+ character random ' +
        'secret before integration tools can be used. ' +
        'Generate one via: openssl rand -base64 48'
    )
  }
  return secret
}

function generateSigningSecret(): string {
  return 'whsec_' + randomBytes(32).toString('hex')
}

function generateApiKey(): string {
  return 'sk_int_' + randomBytes(32).toString('base64url')
}

/** Hash an API key for storage (one-way) */
export function hashApiKey(key: string): string {
  return createHmac('sha256', getKeyHmacSecret()).update(key).digest('hex')
}

/** Compute HMAC-SHA256 signature for webhook delivery */
export function computeHmacSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

// ============================================================================
// Expiration helper
// ============================================================================

function computeExpiresAt(expiresIn?: string): string | null {
  if (!expiresIn || expiresIn === 'never') return null
  const days = parseInt(expiresIn, 10)
  if (isNaN(days)) return null
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

// ============================================================================
// Row mappers
// ============================================================================

function rowToWebhookMasked(row: Record<string, unknown>): WebhookMasked {
  const secret = String(row.signing_secret ?? '')
  return {
    id: String(row.id),
    url: String(row.url),
    events: row.events as string[],
    description: row.description ? String(row.description) : null,
    signingSecretLast4: secret.slice(-4),
    status: row.status as 'active' | 'inactive',
    createdAt: String(row.created_at),
    lastDeliveryAt: row.last_delivery_at ? String(row.last_delivery_at) : null,
  }
}

function rowToApiKeyMasked(row: Record<string, unknown>): ApiKeyMasked {
  const prefix = String(row.key_prefix ?? '')
  return {
    id: String(row.id),
    name: String(row.name),
    keyLast4: prefix.slice(-4),
    keyPrefix: prefix,
    permissions: row.permissions as string[],
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    createdAt: String(row.created_at),
    status: row.revoked_at ? 'revoked' : 'active',
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a real IntegrationService backed by Supabase.
 *
 * @param supabase - Supabase client (anon or service-role)
 * @param teamId - Team ID for row-level scoping
 */
export function createRealIntegrationService(
  supabase: SupabaseClient,
  teamId: string
): IntegrationService {
  // Rate limiting for test delivery (per webhook, in-memory)
  const testDeliveryTimestamps = new Map<string, number>()

  return {
    // ========================================================================
    // Webhooks
    // ========================================================================

    async createWebhook(url, events, description) {
      const urlCheck = validateExternalUrl(url)
      if (!urlCheck.valid) {
        throw new Error(`Invalid webhook URL: ${urlCheck.error}`)
      }

      const signingSecret = generateSigningSecret()

      const { data, error } = await supabase
        .from('webhook_endpoints')
        .insert({
          team_id: teamId,
          url,
          events,
          description: description ?? null,
          signing_secret: signingSecret,
          status: 'active',
        })
        .select()
        .single()

      if (error || !data) {
        throw new Error(`Failed to create webhook: ${error?.message ?? 'no data returned'}`)
      }

      return {
        id: String(data.id),
        url: String(data.url),
        events: data.events as string[],
        description: data.description ? String(data.description) : null,
        signingSecret,
        status: data.status as 'active' | 'inactive',
        createdAt: String(data.created_at),
        lastDeliveryAt: data.last_delivery_at ? String(data.last_delivery_at) : null,
      }
    },

    async listWebhooks() {
      const result = (await supabase
        .from('webhook_endpoints')
        .select('*')
        .eq('team_id', teamId)
        .order('created_at', { ascending: false })) as unknown as SupabaseListResult

      if (result.error) {
        throw new Error(`Failed to list webhooks: ${result.error.message}`)
      }

      const rows = (result.data as Record<string, unknown>[]) ?? []
      return rows.map(rowToWebhookMasked)
    },

    async getWebhook(webhookId) {
      const { data, error } = await supabase
        .from('webhook_endpoints')
        .select('*')
        .eq('id', webhookId)
        .eq('team_id', teamId)
        .single()

      if (error || !data) return null
      return rowToWebhookMasked(data as Record<string, unknown>)
    },

    async deleteWebhook(webhookId) {
      const result = (await supabase
        .from('webhook_endpoints')
        .delete()
        .eq('id', webhookId)
        .eq('team_id', teamId)) as unknown as SupabaseListResult

      return !result.error
    },

    async testWebhook(webhookId) {
      // Rate limit: max 1 test delivery per webhook per minute
      const lastTest = testDeliveryTimestamps.get(webhookId)
      if (lastTest && Date.now() - lastTest < TEST_RATE_LIMIT_MS) {
        return {
          success: false,
          statusCode: 0,
          message: 'Rate limited: max 1 test delivery per webhook per minute.',
        }
      }

      const { data: wh, error } = await supabase
        .from('webhook_endpoints')
        .select('*')
        .eq('id', webhookId)
        .eq('team_id', teamId)
        .single()

      if (error || !wh) {
        return { success: false, statusCode: 0, message: 'Webhook not found.' }
      }

      const whData = wh as Record<string, unknown>

      // SSRF validation on stored URL (may have been updated externally)
      const urlCheck = validateExternalUrl(String(whData.url))
      if (!urlCheck.valid) {
        return {
          success: false,
          statusCode: 0,
          message: `Webhook URL blocked: ${urlCheck.error}`,
        }
      }

      const timestamp = new Date().toISOString()
      const payload = JSON.stringify({ event: 'test', timestamp, webhookId })
      const signature = computeHmacSignature(String(whData.signing_secret), payload)

      try {
        const response = await fetch(String(whData.url), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Skillsmith-Signature': `sha256=${signature}`,
            'X-Skillsmith-Timestamp': timestamp,
          },
          body: payload,
          signal: AbortSignal.timeout(TEST_DELIVERY_TIMEOUT_MS),
        })

        testDeliveryTimestamps.set(webhookId, Date.now())

        // Update last_delivery_at (fire-and-forget)
        void (supabase
          .from('webhook_endpoints')
          .update({ last_delivery_at: new Date().toISOString() })
          .eq('id', webhookId) as unknown as Promise<SupabaseListResult>)

        return {
          success: response.ok,
          statusCode: response.status,
          message: `Test delivery to ${whData.url}: HTTP ${response.status}`,
        }
      } catch (err) {
        return {
          success: false,
          statusCode: 0,
          message: `Test delivery failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        }
      }
    },

    async rotateSecret(webhookId) {
      const newSecret = generateSigningSecret()

      const result = (await supabase
        .from('webhook_endpoints')
        .update({ signing_secret: newSecret })
        .eq('id', webhookId)
        .eq('team_id', teamId)) as unknown as SupabaseListResult

      if (result.error) {
        throw new Error(`Webhook "${webhookId}" not found.`)
      }

      return { webhookId, newSigningSecret: newSecret }
    },

    // ========================================================================
    // API Keys
    // ========================================================================

    async createApiKey(name, permissions, expiresIn) {
      const keyValue = generateApiKey()
      const keyPrefix = keyValue.slice(0, API_KEY_PREFIX_LENGTH)
      const keyHash = hashApiKey(keyValue)
      const expiresAt = computeExpiresAt(expiresIn)

      const { data, error } = await supabase
        .from('api_keys')
        .insert({
          team_id: teamId,
          name,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          permissions: permissions ?? ['read'],
          expires_at: expiresAt,
        })
        .select()
        .single()

      if (error || !data) {
        throw new Error(`Failed to create API key: ${error?.message ?? 'no data returned'}`)
      }

      return {
        id: String(data.id),
        name: String(data.name),
        keyValue,
        keyPrefix,
        permissions: data.permissions as string[],
        expiresAt: data.expires_at ? String(data.expires_at) : null,
        createdAt: String(data.created_at),
      }
    },

    async listApiKeys() {
      const result = (await supabase
        .from('api_keys')
        .select('*')
        .eq('team_id', teamId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false })) as unknown as SupabaseListResult

      if (result.error) {
        throw new Error(`Failed to list API keys: ${result.error.message}`)
      }

      const rows = (result.data as Record<string, unknown>[]) ?? []
      return rows.map(rowToApiKeyMasked)
    },

    async getApiKey(keyId) {
      const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('id', keyId)
        .eq('team_id', teamId)
        .single()

      if (error || !data) return null
      return rowToApiKeyMasked(data as Record<string, unknown>)
    },

    async revokeApiKey(keyId) {
      const result = (await supabase
        .from('api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', keyId)
        .eq('team_id', teamId)
        .is('revoked_at', null)) as unknown as SupabaseListResult

      return !result.error
    },
  }
}

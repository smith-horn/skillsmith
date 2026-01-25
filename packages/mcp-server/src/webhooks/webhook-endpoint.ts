/**
 * SMI-645: Webhook Endpoint - HTTP server for GitHub webhooks
 *
 * Provides:
 * - Express/Node.js HTTP server for receiving webhooks
 * - Signature validation middleware
 * - Rate limiting for security
 * - Event routing to WebhookHandler
 *
 * Usage:
 *   import { createWebhookServer, startWebhookServer } from './webhooks/webhook-endpoint.js';
 *
 *   const server = createWebhookServer({
 *     secret: process.env.GITHUB_WEBHOOK_SECRET,
 *     onIndexUpdate: (repoUrl, filePath) => { ... },
 *   });
 *
 *   startWebhookServer(server, { port: 3000 });
 */

import { createServer, Server } from 'http'
import {
  WebhookHandler,
  WebhookQueue,
  type WebhookQueueItem,
  type WebhookHandleResult,
} from '@skillsmith/core'

// Import helpers from webhook-helpers.ts
import {
  createRateLimiter,
  isRateLimited,
  getClientIp,
  readBody,
  sendJson,
  type WebhookServerConfig,
} from './webhook-helpers.js'

// Re-export types that were moved to helpers
export type { WebhookServerConfig, RateLimiterState } from './webhook-helpers.js'
export {
  createRateLimiter,
  destroyRateLimiter,
  isRateLimited,
  getClientIp,
} from './webhook-helpers.js'

/**
 * Webhook server options
 */
export interface WebhookServerOptions extends WebhookServerConfig {
  /**
   * Maximum request body size in bytes (default: 1MB)
   */
  maxBodySize?: number

  /**
   * Rate limit: max requests per window (default: 100)
   */
  rateLimit?: number

  /**
   * Rate limit window in ms (default: 60000 = 1 minute)
   */
  rateLimitWindow?: number

  /**
   * Callback when a skill needs to be indexed/updated
   */
  onIndexUpdate?: (item: WebhookQueueItem) => Promise<void>

  /**
   * Callback for logging
   */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void

  /**
   * Queue options for debouncing and retry
   */
  queueOptions?: {
    debounceMs?: number
    maxRetries?: number
    retryDelayMs?: number
  }
}

/**
 * Server startup options
 */
export interface ServerStartOptions {
  /**
   * Port to listen on (default: 3000)
   */
  port?: number

  /**
   * Host to bind to (default: '0.0.0.0')
   */
  host?: string
}

/**
 * Webhook server instance
 */
export interface WebhookServer {
  /**
   * The underlying HTTP server
   */
  server: Server

  /**
   * The webhook handler
   */
  handler: WebhookHandler

  /**
   * The webhook queue
   */
  queue: WebhookQueue
}

/**
 * Create a webhook server
 */
export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
  const {
    secret,
    maxBodySize = 1024 * 1024, // 1MB
    rateLimit = 100,
    rateLimitWindow = 60000, // 1 minute
    trustProxy = false, // SMI-682: Default to not trusting proxy
    trustedProxies,
    onIndexUpdate,
    onLog = () => {},
    queueOptions = {},
  } = options

  // SMI-682: Config for getClientIp
  const serverConfig: WebhookServerConfig = {
    secret,
    trustProxy,
    trustedProxies,
  }

  // Create rate limiter
  const rateLimiter = createRateLimiter(rateLimit, rateLimitWindow)

  // Create queue with processor
  const queue = new WebhookQueue({
    debounceMs: queueOptions.debounceMs ?? 5000,
    maxRetries: queueOptions.maxRetries ?? 3,
    retryDelayMs: queueOptions.retryDelayMs ?? 1000,
    processor: onIndexUpdate,
    onLog,
  })

  // Create handler
  const handler = new WebhookHandler({
    secret,
    queue,
    onLog,
  })

  // Create HTTP server
  const server = createServer(async (req, res) => {
    const url = req.url || ''
    const method = req.method || 'GET'

    // Health check endpoint
    if (url === '/health' && method === 'GET') {
      sendJson(res, 200, {
        status: 'healthy',
        queue: queue.getStats(),
      })
      return
    }

    // Webhook endpoint
    if (url === '/webhooks/github' && method === 'POST') {
      // SMI-682: Use config for trusted proxy validation
      const clientIp = getClientIp(req, serverConfig)

      // Rate limiting
      if (isRateLimited(rateLimiter, clientIp)) {
        onLog('warn', 'Rate limit exceeded', { ip: clientIp })
        sendJson(res, 429, {
          error: 'Too many requests',
          retryAfter: Math.ceil(rateLimitWindow / 1000),
        })
        return
      }

      // Get event type from header
      const eventType = req.headers['x-github-event'] as string | undefined
      if (!eventType) {
        sendJson(res, 400, { error: 'Missing X-GitHub-Event header' })
        return
      }

      // Get signature from header
      const signature = req.headers['x-hub-signature-256'] as string | undefined
      if (!signature) {
        sendJson(res, 401, { error: 'Missing X-Hub-Signature-256 header' })
        return
      }

      // Get delivery ID for idempotency
      const deliveryId = req.headers['x-github-delivery'] as string | undefined

      // Read body
      let body: string
      try {
        body = await readBody(req, maxBodySize)
      } catch {
        sendJson(res, 413, { error: 'Request body too large' })
        return
      }

      // Process webhook (pass delivery ID for idempotency)
      let result: WebhookHandleResult
      try {
        result = await handler.handleWebhook(eventType, body, signature, deliveryId)
      } catch (error) {
        onLog('error', 'Webhook processing error', {
          error: error instanceof Error ? error.message : String(error),
        })
        sendJson(res, 500, { error: 'Internal server error' })
        return
      }

      // Send response
      if (result.success) {
        sendJson(res, 200, {
          success: true,
          message: result.message,
          changesDetected: result.changesDetected,
          itemsQueued: result.itemsQueued,
        })
      } else {
        const statusCode = result.error?.includes('Signature') ? 401 : 400
        sendJson(res, statusCode, {
          success: false,
          error: result.error,
        })
      }
      return
    }

    // Queue status endpoint (for monitoring)
    if (url === '/webhooks/status' && method === 'GET') {
      sendJson(res, 200, {
        queue: queue.getStats(),
        hasPending: queue.hasPendingItems(),
      })
      return
    }

    // 404 for unknown routes
    sendJson(res, 404, { error: 'Not found' })
  })

  return { server, handler, queue }
}

/**
 * Start the webhook server
 */
export function startWebhookServer(
  webhookServer: WebhookServer,
  options: ServerStartOptions = {}
): Promise<void> {
  const { port = 3000, host = '0.0.0.0' } = options

  return new Promise((resolve) => {
    webhookServer.server.listen(port, host, () => {
      console.log(`Webhook server listening on http://${host}:${port}`)
      console.log(`GitHub webhook URL: http://${host}:${port}/webhooks/github`)
      resolve()
    })
  })
}

/**
 * Stop the webhook server
 */
export function stopWebhookServer(webhookServer: WebhookServer): Promise<void> {
  return new Promise((resolve, reject) => {
    webhookServer.queue.clear()
    webhookServer.server.close((err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

/**
 * Main entry point for standalone webhook server
 */
export async function main(): Promise<void> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET

  if (!secret) {
    console.error('Error: GITHUB_WEBHOOK_SECRET environment variable is required')
    process.exit(1)
  }

  const port = parseInt(process.env.WEBHOOK_PORT || '3000', 10)
  const host = process.env.WEBHOOK_HOST || '0.0.0.0'

  const webhookServer = createWebhookServer({
    secret,
    onLog: (level, message, data) => {
      const timestamp = new Date().toISOString()
      console.log(
        `[${timestamp}] [${level.toUpperCase()}] ${message}`,
        data ? JSON.stringify(data) : ''
      )
    },
    onIndexUpdate: async (item) => {
      // In standalone mode, just log the update
      // In production, this would trigger re-indexing
      console.log(`[INDEX UPDATE] ${item.type}: ${item.repoFullName} - ${item.filePath}`)
    },
  })

  await startWebhookServer(webhookServer, { port, host })

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down webhook server...')
    await stopWebhookServer(webhookServer)
    console.log('Webhook server stopped')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Run if this is the main module
// Note: ESM doesn't have require.main === module, so we check for CLI flag
if (process.argv.includes('--standalone')) {
  main().catch((error) => {
    console.error('Failed to start webhook server:', error)
    process.exit(1)
  })
}

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

import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import {
  WebhookHandler,
  WebhookQueue,
  type WebhookQueueItem,
  type WebhookHandleResult,
} from '@skillsmith/core'

/**
 * Webhook server configuration (SMI-682: Added trust proxy options)
 */
export interface WebhookServerConfig {
  /**
   * GitHub webhook secret for signature verification
   */
  secret: string

  /**
   * Whether to trust X-Forwarded-For headers (default: false)
   * SMI-682: Must be explicitly enabled for security
   */
  trustProxy?: boolean

  /**
   * List of trusted proxy IPs (optional, for enhanced security)
   * SMI-682: When set, X-Forwarded-For is only trusted from these IPs
   */
  trustedProxies?: string[]
}

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
 * Rate limiter state (SMI-681: Added cleanup timer for memory leak prevention)
 */
export interface RateLimiterState {
  requests: Map<string, number[]>
  limit: number
  window: number
  cleanupTimer?: ReturnType<typeof setInterval>
}

/**
 * Create rate limiter with automatic cleanup (SMI-681)
 * @param limit - Maximum requests per window
 * @param windowMs - Window duration in milliseconds
 */
export function createRateLimiter(limit: number, windowMs: number): RateLimiterState {
  const state: RateLimiterState = {
    requests: new Map(),
    limit,
    window: windowMs,
  }

  // SMI-681: Periodic cleanup to prevent memory leak
  state.cleanupTimer = setInterval(() => {
    const now = Date.now()
    const windowStart = now - windowMs

    for (const [ip, timestamps] of state.requests.entries()) {
      const valid = timestamps.filter((t) => t > windowStart)
      if (valid.length === 0) {
        state.requests.delete(ip)
      } else {
        state.requests.set(ip, valid)
      }
    }
  }, windowMs)

  // Don't block process exit
  if (state.cleanupTimer.unref) {
    state.cleanupTimer.unref()
  }

  return state
}

/**
 * Destroy rate limiter and clean up resources (SMI-681)
 */
export function destroyRateLimiter(state: RateLimiterState): void {
  if (state.cleanupTimer) {
    clearInterval(state.cleanupTimer)
    state.cleanupTimer = undefined
  }
  state.requests.clear()
}

/**
 * Check if request is rate limited
 */
export function isRateLimited(limiter: RateLimiterState, ip: string): boolean {
  const now = Date.now()
  const windowStart = now - limiter.window

  // Get existing requests for this IP
  let requests = limiter.requests.get(ip) || []

  // Filter to only requests within the window
  requests = requests.filter((time) => time > windowStart)

  // Check if over limit
  if (requests.length >= limiter.limit) {
    return true
  }

  // Add this request
  requests.push(now)
  limiter.requests.set(ip, requests)

  return false
}

/**
 * Get client IP from request (SMI-682: Added trusted proxy validation)
 * @param req - Incoming HTTP request
 * @param config - Server configuration with trust proxy settings
 */
export function getClientIp(req: IncomingMessage, config: WebhookServerConfig): string {
  // SMI-682: Only trust X-Forwarded-For if explicitly configured
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string') {
      const clientIp = forwarded.split(',')[0].trim()

      // If trustedProxies specified, verify the request came from one
      if (config.trustedProxies?.length) {
        const remoteIp = req.socket.remoteAddress
        if (!config.trustedProxies.includes(remoteIp || '')) {
          // Don't trust forwarded header from untrusted source
          return remoteIp || 'unknown'
        }
      }

      return clientIp
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      const clientIp = forwarded[0].split(',')[0].trim()

      // If trustedProxies specified, verify the request came from one
      if (config.trustedProxies?.length) {
        const remoteIp = req.socket.remoteAddress
        if (!config.trustedProxies.includes(remoteIp || '')) {
          return remoteIp || 'unknown'
        }
      }

      return clientIp
    }
  }

  // Fall back to socket address
  return req.socket.remoteAddress || 'unknown'
}

/**
 * Read request body with size limit
 */
async function readBody(req: IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxSize) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })

    req.on('error', reject)
  })
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: Record<string, unknown>): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
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
      } catch (error) {
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

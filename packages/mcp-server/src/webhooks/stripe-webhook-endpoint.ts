/**
 * SMI-1070: Stripe Webhook Endpoint
 *
 * HTTP endpoint for receiving Stripe webhooks.
 * Integrates with the existing webhook server infrastructure.
 *
 * Features:
 * - Signature verification
 * - Rate limiting (STRIPE_WEBHOOK preset)
 * - Idempotent event processing
 * - Health check endpoint
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import {
  createRateLimiter,
  destroyRateLimiter,
  isRateLimited,
  getClientIp,
} from './webhook-endpoint.js'
import type { RateLimiterState, WebhookServerConfig } from './webhook-endpoint.js'
import type { StripeWebhookHandler } from '@skillsmith/core/billing'

// ============================================================================
// Configuration
// ============================================================================

export interface StripeWebhookServerConfig {
  /**
   * Stripe webhook signing secret
   */
  webhookSecret: string

  /**
   * Whether to trust proxy headers
   */
  trustProxy?: boolean

  /**
   * Trusted proxy IPs
   */
  trustedProxies?: string[]

  /**
   * Maximum request body size (default: 64KB)
   */
  maxBodySize?: number

  /**
   * Rate limit: max requests per minute (default: 100)
   */
  rateLimit?: number
}

export interface StripeWebhookServerOptions extends StripeWebhookServerConfig {
  /**
   * Webhook handler instance
   */
  webhookHandler: StripeWebhookHandler

  /**
   * Logging callback
   */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void
}

export interface StripeWebhookServer {
  server: Server
  rateLimiter: RateLimiterState
  stop: () => Promise<void>
}

// ============================================================================
// Server Creation
// ============================================================================

/**
 * Create a Stripe webhook server
 */
export function createStripeWebhookServer(
  options: StripeWebhookServerOptions
): StripeWebhookServer {
  const {
    webhookSecret,
    trustProxy = false,
    trustedProxies,
    maxBodySize = 65536, // 64KB - Stripe events are small
    rateLimit = 100,
    webhookHandler,
    onLog = () => {},
  } = options

  const serverConfig: WebhookServerConfig = {
    secret: webhookSecret,
    trustProxy,
    trustedProxies,
  }

  // Create rate limiter with Stripe-optimized settings
  const rateLimiter = createRateLimiter(rateLimit, 60000)

  /**
   * Read request body with size limit
   */
  async function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0

      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBodySize) {
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

  // Create HTTP server
  const server = createServer(async (req, res) => {
    const url = req.url || ''
    const method = req.method || 'GET'

    // Health check endpoint
    if (url === '/webhooks/stripe/health' && method === 'GET') {
      sendJson(res, 200, {
        status: 'healthy',
        service: 'stripe-webhook',
        timestamp: new Date().toISOString(),
      })
      return
    }

    // Stripe webhook endpoint
    if (url === '/webhooks/stripe' && method === 'POST') {
      const clientIp = getClientIp(req, serverConfig)

      // Rate limiting
      if (isRateLimited(rateLimiter, clientIp)) {
        onLog('warn', 'Stripe webhook rate limit exceeded', { ip: clientIp })
        sendJson(res, 429, {
          error: 'Too many requests',
          retryAfter: 60,
        })
        return
      }

      // Get signature from header
      const signature = req.headers['stripe-signature'] as string | undefined
      if (!signature) {
        onLog('warn', 'Missing Stripe signature header')
        sendJson(res, 401, { error: 'Missing Stripe-Signature header' })
        return
      }

      // Read body
      let body: string
      try {
        body = await readBody(req)
      } catch {
        sendJson(res, 413, { error: 'Request body too large' })
        return
      }

      // Process webhook
      try {
        const result = await webhookHandler.handleWebhook(body, signature)

        if (result.success) {
          sendJson(res, 200, {
            received: true,
            eventId: result.eventId,
            processed: result.processed,
            message: result.message,
          })
        } else {
          // 400 for validation errors, 401 for signature errors
          const statusCode = result.error?.includes('signature') ? 401 : 400
          sendJson(res, statusCode, {
            received: false,
            error: result.error,
          })
        }
      } catch (error) {
        onLog('error', 'Stripe webhook processing error', {
          error: error instanceof Error ? error.message : String(error),
        })
        sendJson(res, 500, { error: 'Internal server error' })
      }
      return
    }

    // 404 for unknown routes
    sendJson(res, 404, { error: 'Not found' })
  })

  return {
    server,
    rateLimiter,
    stop: async () => {
      destroyRateLimiter(rateLimiter)
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}

/**
 * Start the Stripe webhook server
 */
export function startStripeWebhookServer(
  webhookServer: StripeWebhookServer,
  options: { port?: number; host?: string } = {}
): Promise<void> {
  const { port = 3001, host = '0.0.0.0' } = options

  return new Promise((resolve) => {
    webhookServer.server.listen(port, host, () => {
      console.log(`Stripe webhook server listening on http://${host}:${port}`)
      console.log(`Stripe webhook URL: http://${host}:${port}/webhooks/stripe`)
      resolve()
    })
  })
}

/**
 * Standalone entry point for Stripe webhook server
 */
export async function main(): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!webhookSecret) {
    console.error('Error: STRIPE_WEBHOOK_SECRET environment variable is required')
    process.exit(1)
  }

  // In production, this would be initialized with real services
  // For standalone mode, we just log events
  console.log('Starting Stripe webhook server in standalone mode...')
  console.log('Note: Full integration requires BillingService and StripeClient')

  // This is a stub - in production, pass a real StripeWebhookHandler
  const mockHandler = {
    handleWebhook: async (payload: string, signature: string) => {
      console.log(`[WEBHOOK] Received event, signature: ${signature.slice(0, 20)}...`)
      return {
        success: true,
        message: 'Event logged (standalone mode)',
        eventId: 'evt_standalone',
        processed: false,
      }
    },
  }

  const webhookServer = createStripeWebhookServer({
    webhookSecret,
    webhookHandler: mockHandler as unknown as StripeWebhookHandler,
    onLog: (level, message, data) => {
      const timestamp = new Date().toISOString()
      console.log(
        `[${timestamp}] [${level.toUpperCase()}] ${message}`,
        data ? JSON.stringify(data) : ''
      )
    },
  })

  const port = parseInt(process.env.STRIPE_WEBHOOK_PORT || '3001', 10)
  const host = process.env.STRIPE_WEBHOOK_HOST || '0.0.0.0'

  await startStripeWebhookServer(webhookServer, { port, host })

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down Stripe webhook server...')
    await webhookServer.stop()
    console.log('Server stopped')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv.includes('--stripe-standalone')) {
  main().catch((error) => {
    console.error('Failed to start Stripe webhook server:', error)
    process.exit(1)
  })
}

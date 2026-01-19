/**
 * Early Access Signup Handler
 * @module early-access-signup
 *
 * Handles email signups from the beta landing page.
 * Stores signups in the database and sends confirmation emails via Resend.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCorsPreflightRequest, jsonResponse, errorResponse } from '../_shared/cors.ts'

interface EarlyAccessSignup {
  email: string
  source?: 'homepage_hero' | 'homepage_cta' | 'api' | 'other'
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  metadata?: Record<string, unknown>
  website?: string // Honeypot field
}

// Rate limiting: max signups per IP per hour
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour

// In-memory rate limit store (resets on function cold start)
const rateLimitStore = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string | null): { allowed: boolean; remaining: number } {
  if (!ip) return { allowed: true, remaining: RATE_LIMIT_MAX }

  const now = Date.now()
  const record = rateLimitStore.get(ip)

  if (!record || now > record.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 }
  }

  record.count++
  return { allowed: true, remaining: RATE_LIMIT_MAX - record.count }
}

// Stricter email validation (RFC 5321 compliant basics)
const EMAIL_REGEX =
  /^[^\s@]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/
const MAX_EMAIL_LENGTH = 320

function isValidEmail(email: string): boolean {
  if (!email || email.length > MAX_EMAIL_LENGTH) return false
  return EMAIL_REGEX.test(email)
}

// Sanitize metadata to prevent XSS if displayed
function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {}

  // Only allow safe primitive values, limit size
  const sanitized: Record<string, unknown> = {}
  const maxKeys = 10
  const maxStringLength = 200

  let keyCount = 0
  for (const [key, value] of Object.entries(metadata)) {
    if (keyCount >= maxKeys) break

    // Only allow alphanumeric keys
    if (!/^[a-zA-Z0-9_]+$/.test(key)) continue

    if (typeof value === 'string') {
      // Strip HTML tags and limit length
      sanitized[key] = value.replace(/<[^>]*>/g, '').slice(0, maxStringLength)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value
    }
    keyCount++
  }

  return sanitized
}

async function sendConfirmationEmail(email: string) {
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  if (!resendApiKey) {
    console.warn('RESEND_API_KEY not configured - skipping confirmation email')
    return { success: false, error: 'Email not configured' }
  }

  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #0D0D0F; margin: 0; font-size: 28px; font-weight: 700;">You're on the list!</h1>
      </div>

      <p style="color: #3F3F46; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
        Thanks for signing up for early access to <strong>Skillsmith</strong>. We're building the best way to discover and install skills for Claude Code.
      </p>

      <p style="color: #3F3F46; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
        You'll be among the first to know when we launch. In the meantime, here's what we're working on:
      </p>

      <ul style="color: #3F3F46; font-size: 16px; line-height: 1.8; margin-bottom: 24px; padding-left: 20px;">
        <li><strong>Semantic search</strong> across 14,000+ curated skills</li>
        <li><strong>Quality scores</strong> based on docs, tests, and maintenance</li>
        <li><strong>Stack-aware recommendations</strong> tailored to your project</li>
        <li><strong>One-click installation</strong> directly to Claude Code</li>
      </ul>

      <p style="color: #3F3F46; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
        We'll reach out soon with your invite.
      </p>

      <p style="color: #71717A; font-size: 14px; line-height: 1.6;">
        — The Skillsmith Team
      </p>

      <hr style="border: none; border-top: 1px solid #E4E4E7; margin: 32px 0;" />

      <p style="color: #A1A1AA; font-size: 12px; text-align: center;">
        You received this email because you signed up for Skillsmith early access.<br />
        <a href="https://skillsmith.app" style="color: #E07A5F;">skillsmith.app</a>
      </p>
    </div>
  `

  const emailText = `
You're on the list!

Thanks for signing up for early access to Skillsmith. We're building the best way to discover and install skills for Claude Code.

You'll be among the first to know when we launch. In the meantime, here's what we're working on:

- Semantic search across 14,000+ curated skills
- Quality scores based on docs, tests, and maintenance
- Stack-aware recommendations tailored to your project
- One-click installation directly to Claude Code

We'll reach out soon with your invite.

— The Skillsmith Team

---
You received this email because you signed up for Skillsmith early access.
https://skillsmith.app
  `.trim()

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skillsmith <hello@skillsmith.app>',
        to: [email],
        subject: "You're on the Skillsmith early access list!",
        html: emailHtml,
        text: emailText,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      console.error('Resend API error:', errorData)
      return { success: false, error: errorData }
    }

    const result = await response.json()
    console.log('Confirmation email sent:', result.id)
    return { success: true, emailId: result.id }
  } catch (err) {
    console.error('Failed to send confirmation email:', err)
    return { success: false, error: String(err) }
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest(origin)
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, undefined, origin)
  }

  try {
    const body: EarlyAccessSignup = await req.json()

    // Extract IP for rate limiting
    const ipAddress =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('cf-connecting-ip') ||
      null

    // Honeypot check - if filled, silently "succeed" (bot detected)
    if (body.website) {
      console.log('Honeypot triggered from IP:', ipAddress)
      return jsonResponse(
        {
          success: true,
          message: "You're on the list! Check your email for confirmation.",
          isNew: true,
        },
        200,
        origin
      )
    }

    // Rate limiting
    const rateLimit = checkRateLimit(ipAddress)
    if (!rateLimit.allowed) {
      return errorResponse('Too many requests. Please try again later.', 429, undefined, origin)
    }

    // Validate email
    if (!body.email) {
      return errorResponse('Email is required', 400, undefined, origin)
    }

    if (!isValidEmail(body.email)) {
      return errorResponse('Please enter a valid email address', 400, undefined, origin)
    }

    // Validate source if provided
    const validSources = ['homepage_hero', 'homepage_cta', 'api', 'other']
    const source = body.source && validSources.includes(body.source) ? body.source : 'other'

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Extract remaining request metadata
    const userAgent = req.headers.get('user-agent') || null
    const referrer = req.headers.get('referer') || null

    // Prepare signup data with sanitized metadata
    const signupData = {
      email: body.email.trim().toLowerCase(),
      source,
      ip_address: ipAddress,
      user_agent: userAgent,
      referrer,
      utm_source: body.utm_source?.slice(0, 100) || null,
      utm_medium: body.utm_medium?.slice(0, 100) || null,
      utm_campaign: body.utm_campaign?.slice(0, 100) || null,
      metadata: sanitizeMetadata(body.metadata),
      status: 'pending',
      updated_at: new Date().toISOString(),
    }

    // Upsert to handle duplicates gracefully
    const { data, error } = await supabase
      .from('early_access_signups')
      .upsert(signupData, {
        onConflict: 'email',
        ignoreDuplicates: false, // Update the record on conflict
      })
      .select('id, created_at, updated_at')
      .single()

    if (error) {
      console.error('Database error:', error)

      // Check if table doesn't exist yet
      if (error.code === '42P01') {
        console.warn('early_access_signups table does not exist')
        return errorResponse('Service temporarily unavailable', 503, undefined, origin)
      }

      return errorResponse('Failed to process signup', 500, undefined, origin)
    }

    // Determine if this is a new signup or existing
    const isNewSignup = data.created_at === data.updated_at

    if (isNewSignup) {
      // Send confirmation email for new signups (non-blocking)
      sendConfirmationEmail(body.email.trim().toLowerCase()).catch((err) => {
        console.error('Background email send failed:', err)
      })

      return jsonResponse(
        {
          success: true,
          message: "You're on the list! Check your email for confirmation.",
          isNew: true,
        },
        200,
        origin
      )
    } else {
      // Existing signup
      return jsonResponse(
        {
          success: true,
          message: "You're already on the list! We'll notify you when it's your turn.",
          isNew: false,
        },
        200,
        origin
      )
    }
  } catch (err) {
    console.error('Early access signup error:', err)
    return errorResponse('Invalid request', 400, undefined, origin)
  }
})

/**
 * Email utilities using Resend
 * @module _shared/email
 *
 * SMI-1591: Welcome email with license key
 *
 * Provides email sending capabilities via Resend API.
 * Used for welcome emails, payment notifications, etc.
 */

// Resend API endpoint
const RESEND_API_URL = 'https://api.resend.com/emails'

// Get Resend API key from environment
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

// Email sender configuration
const FROM_EMAIL = Deno.env.get('EMAIL_FROM') || 'Skillsmith <noreply@skillsmith.dev>'
const REPLY_TO_EMAIL = Deno.env.get('EMAIL_REPLY_TO') || 'support@skillsmith.dev'

// Dashboard and docs URLs
const DASHBOARD_URL = Deno.env.get('DASHBOARD_URL') || 'https://skillsmith.dev/account'
const DOCS_URL = Deno.env.get('DOCS_URL') || 'https://skillsmith.dev/docs'
const QUICKSTART_URL = Deno.env.get('QUICKSTART_URL') || 'https://skillsmith.dev/docs/quickstart'

/**
 * Tier information for email content
 */
export const TIER_INFO: Record<string, { name: string; features: string[] }> = {
  individual: {
    name: 'Individual',
    features: [
      '10,000 API calls per month',
      'Core features + basic analytics',
      '3 license keys',
      '60 requests/minute rate limit',
    ],
  },
  team: {
    name: 'Team',
    features: [
      '100,000 API calls per month',
      'Team workspaces and collaboration',
      'Private skills',
      '10 license keys per seat',
      '120 requests/minute rate limit',
    ],
  },
  enterprise: {
    name: 'Enterprise',
    features: [
      'Unlimited API calls',
      'SSO and RBAC',
      'Audit logging',
      'Priority support',
      '50 license keys per seat',
      '300 requests/minute rate limit',
    ],
  },
}

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

/**
 * Send an email via Resend
 *
 * @param to - Recipient email address
 * @param subject - Email subject
 * @param html - HTML content
 * @param text - Plain text content (optional, recommended for deliverability)
 * @returns True if email was sent successfully
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string
): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not configured, skipping email send')
    return false
  }

  if (!isValidEmail(to)) {
    console.error('Invalid email address:', to)
    return false
  }

  try {
    const emailPayload: Record<string, unknown> = {
      from: FROM_EMAIL,
      to: [to],
      reply_to: REPLY_TO_EMAIL,
      subject,
      html,
    }

    // Add plain text version if provided (improves deliverability)
    if (text) {
      emailPayload.text = text
    }

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('Resend API error:', response.status, error)
      return false
    }

    const result = await response.json()
    console.log('Email sent successfully', { to, messageId: result.id })
    return true
  } catch (error) {
    console.error('Failed to send email:', error)
    return false
  }
}

/**
 * Generate welcome email HTML with license key
 *
 * @param params - Email parameters
 * @returns HTML string
 */
export function generateWelcomeEmailHtml(params: {
  licenseKey: string
  tier: string
  customerName?: string
  billingPeriod?: string
  seatCount?: number
}): string {
  const { licenseKey, tier, customerName, billingPeriod = 'monthly', seatCount = 1 } = params
  const tierInfo = TIER_INFO[tier] || TIER_INFO.individual

  const greeting = customerName ? `Hi ${customerName},` : 'Hi there,'

  const featuresHtml = tierInfo.features
    .map((feature) => `<li style="margin-bottom: 8px;">${feature}</li>`)
    .join('\n')

  const seatText = seatCount > 1 ? ` (${seatCount} seats)` : ''
  const periodText = billingPeriod === 'annual' ? 'annual' : 'monthly'

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Skillsmith</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);">
    <!-- Header -->
    <div style="text-align: center; margin-bottom: 32px;">
      <h1 style="color: #6366f1; margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">
        Skillsmith
      </h1>
      <p style="color: #6b7280; margin: 0; font-size: 14px;">
        AI Skill Discovery & Management
      </p>
    </div>

    <!-- Welcome Message -->
    <p style="margin: 0 0 24px 0; font-size: 16px;">${greeting}</p>

    <p style="margin: 0 0 24px 0; font-size: 16px;">
      Thank you for subscribing to <strong>Skillsmith ${tierInfo.name}</strong>${seatText} (${periodText} billing).
      Your account is now active and ready to use!
    </p>

    <!-- License Key Section -->
    <div style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h2 style="color: #92400e; margin: 0 0 12px 0; font-size: 16px; font-weight: 600;">
        Your License Key
      </h2>
      <p style="margin: 0 0 12px 0; font-size: 14px; color: #78350f;">
        Save this key securely. It will only be shown once.
      </p>
      <div style="background-color: #fffbeb; border: 1px dashed #d97706; border-radius: 4px; padding: 12px; font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 13px; word-break: break-all; color: #1a1a1a;">
        ${licenseKey}
      </div>
    </div>

    <!-- Quick Setup -->
    <div style="background-color: #f0fdf4; border: 1px solid #22c55e; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h2 style="color: #166534; margin: 0 0 12px 0; font-size: 16px; font-weight: 600;">
        Quick Setup
      </h2>
      <p style="margin: 0 0 12px 0; font-size: 14px; color: #15803d;">
        Add to your <code style="background: #dcfce7; padding: 2px 6px; border-radius: 4px;">~/.claude/settings.json</code>:
      </p>
      <pre style="background-color: #dcfce7; border-radius: 4px; padding: 12px; font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 12px; overflow-x: auto; margin: 0; color: #1a1a1a;">{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_LICENSE_KEY": "your-key-here"
      }
    }
  }
}</pre>
    </div>

    <!-- Tier Features -->
    <div style="margin-bottom: 24px;">
      <h2 style="color: #1a1a1a; margin: 0 0 16px 0; font-size: 18px; font-weight: 600;">
        Your ${tierInfo.name} Plan Includes
      </h2>
      <ul style="margin: 0; padding-left: 20px; color: #374151;">
        ${featuresHtml}
      </ul>
    </div>

    <!-- Action Buttons -->
    <div style="margin-bottom: 24px;">
      <a href="${DASHBOARD_URL}" style="display: inline-block; background-color: #6366f1; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 500; margin-right: 12px; margin-bottom: 8px;">
        Go to Dashboard
      </a>
      <a href="${QUICKSTART_URL}" style="display: inline-block; background-color: #ffffff; color: #6366f1; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 500; border: 1px solid #6366f1;">
        Quick Start Guide
      </a>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">

    <p style="margin: 0 0 8px 0; font-size: 14px; color: #6b7280;">
      Need help? Check our <a href="${DOCS_URL}" style="color: #6366f1;">documentation</a> or reply to this email.
    </p>

    <p style="margin: 0; font-size: 14px; color: #6b7280;">
      Thanks for choosing Skillsmith!
    </p>
  </div>

  <!-- Email Footer -->
  <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
    <p style="margin: 0 0 4px 0;">
      Skillsmith, Inc.
    </p>
    <p style="margin: 0;">
      You received this email because you signed up for Skillsmith.
    </p>
  </div>
</body>
</html>
`
}

/**
 * Generate plain text welcome email
 */
export function generateWelcomeEmailText(params: {
  licenseKey: string
  tier: string
  customerName?: string
  billingPeriod?: string
  seatCount?: number
}): string {
  const { licenseKey, tier, customerName, billingPeriod = 'monthly', seatCount = 1 } = params
  const tierInfo = TIER_INFO[tier] || TIER_INFO.individual

  const greeting = customerName ? `Hi ${customerName},` : 'Hi there,'
  const seatText = seatCount > 1 ? ` (${seatCount} seats)` : ''
  const periodText = billingPeriod === 'annual' ? 'annual' : 'monthly'

  const features = tierInfo.features.map((f) => `  - ${f}`).join('\n')

  return `${greeting}

Thank you for subscribing to Skillsmith ${tierInfo.name}${seatText} (${periodText} billing).
Your account is now active and ready to use!

YOUR LICENSE KEY
================
Save this key securely. It will only be shown once.

${licenseKey}

QUICK SETUP
===========
Add to your ~/.claude/settings.json:

{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_LICENSE_KEY": "your-key-here"
      }
    }
  }
}

YOUR ${tierInfo.name.toUpperCase()} PLAN INCLUDES
${'='.repeat(tierInfo.name.length + 20)}
${features}

USEFUL LINKS
============
Dashboard: ${DASHBOARD_URL}
Quick Start Guide: ${QUICKSTART_URL}
Documentation: ${DOCS_URL}

Need help? Check our documentation or reply to this email.

Thanks for choosing Skillsmith!

--
Skillsmith, Inc.
`
}

/**
 * Send welcome email with license key
 *
 * @param params - Email parameters
 * @returns True if email was sent successfully
 */
export async function sendWelcomeEmail(params: {
  to: string
  licenseKey: string
  tier: string
  customerName?: string
  billingPeriod?: string
  seatCount?: number
}): Promise<boolean> {
  const html = generateWelcomeEmailHtml(params)
  const text = generateWelcomeEmailText(params)
  const tierName = TIER_INFO[params.tier]?.name || 'Individual'

  return sendEmail(
    params.to,
    `Welcome to Skillsmith ${tierName}! Your License Key Inside`,
    html,
    text
  )
}

/**
 * Send payment failed notification email
 *
 * @param to - Recipient email
 * @param attemptCount - Number of failed attempts
 * @returns True if sent successfully
 */
export async function sendPaymentFailedEmail(
  to: string,
  attemptCount: number = 1
): Promise<boolean> {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Failed - Skillsmith</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);">
    <div style="text-align: center; margin-bottom: 32px;">
      <h1 style="color: #6366f1; margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">
        Skillsmith
      </h1>
    </div>

    <div style="background-color: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h2 style="color: #dc2626; margin: 0 0 12px 0; font-size: 18px; font-weight: 600;">
        Payment Failed
      </h2>
      <p style="margin: 0; font-size: 14px; color: #7f1d1d;">
        We were unable to process your payment (attempt ${attemptCount}). Please update your payment method to continue your subscription.
      </p>
    </div>

    <a href="${DASHBOARD_URL}/billing" style="display: inline-block; background-color: #6366f1; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 500;">
      Update Payment Method
    </a>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">

    <p style="margin: 0; font-size: 14px; color: #6b7280;">
      Questions? Reply to this email or contact support.
    </p>
  </div>
</body>
</html>
`

  const text = `PAYMENT FAILED

We were unable to process your payment (attempt ${attemptCount}).

Please update your payment method to continue your subscription.

Update Payment Method: ${DASHBOARD_URL}/billing

Questions? Reply to this email or contact support.

--
Skillsmith, Inc.
`

  return sendEmail(to, 'Action Required: Payment Failed - Skillsmith', html, text)
}

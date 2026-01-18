/**
 * Inbound Email Webhook Handler
 * @module email-inbound
 *
 * Receives inbound emails from Resend and forwards them to support@smithhorn.ca
 */

import { handleCorsPreflightRequest, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { createHmac } from 'node:crypto'

interface ResendWebhookPayload {
  type: string
  created_at: string
  data: {
    email_id: string
    from: string
    to: string[]
    subject: string
    created_at: string
  }
}

interface InboundEmail {
  from: string
  to: string
  subject: string
  html?: string
  text?: string
  attachments?: Array<{
    filename: string
    content: string
    content_type: string
  }>
}

// Verify webhook signature
function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expectedSignature = createHmac('sha256', secret).update(payload).digest('base64')
  return signature === expectedSignature
}

// Fetch full email content from Resend
async function fetchEmailContent(emailId: string, apiKey: string): Promise<InboundEmail | null> {
  try {
    const response = await fetch(`https://api.resend.com/emails/${emailId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (!response.ok) {
      console.error('Failed to fetch email:', await response.text())
      return null
    }

    return await response.json()
  } catch (err) {
    console.error('Error fetching email:', err)
    return null
  }
}

// Forward email to support
async function forwardEmail(
  email: InboundEmail,
  originalTo: string,
  apiKey: string
): Promise<boolean> {
  const forwardedHtml = `
    <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
      <p style="margin: 0; color: #666;">
        <strong>Forwarded inbound email</strong><br/>
        From: ${email.from}<br/>
        To: ${originalTo}<br/>
        Subject: ${email.subject}
      </p>
    </div>
    <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;"/>
    ${email.html || `<pre>${email.text || 'No content'}</pre>`}
  `

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skillsmith Inbound <inbound@skillsmith.app>',
        to: ['support@smithhorn.ca'],
        reply_to: email.from,
        subject: `[Fwd] ${email.subject}`,
        html: forwardedHtml,
        text: `Forwarded from: ${email.from}\nTo: ${originalTo}\n\n${email.text || 'No content'}`,
      }),
    })

    if (!response.ok) {
      console.error('Failed to forward email:', await response.text())
      return false
    }

    console.log('Email forwarded successfully')
    return true
  } catch (err) {
    console.error('Error forwarding email:', err)
    return false
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

  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  const webhookSecret = Deno.env.get('RESEND_WEBHOOK_SECRET')

  if (!resendApiKey) {
    console.error('RESEND_API_KEY not configured')
    return errorResponse('Server configuration error', 500, undefined, origin)
  }

  try {
    const rawBody = await req.text()
    const signature = req.headers.get('resend-signature') || req.headers.get('svix-signature')

    // Verify signature if secret is configured
    if (webhookSecret && signature) {
      if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
        console.error('Invalid webhook signature')
        return errorResponse('Invalid signature', 401, undefined, origin)
      }
    }

    const payload: ResendWebhookPayload = JSON.parse(rawBody)
    console.log('Received webhook:', payload.type)

    // Only process email.received events
    if (payload.type !== 'email.received') {
      console.log('Ignoring event type:', payload.type)
      return jsonResponse({ received: true, processed: false }, 200, origin)
    }

    const emailId = payload.data.email_id
    console.log('Processing inbound email:', emailId)

    // Fetch full email content
    const email = await fetchEmailContent(emailId, resendApiKey)
    if (!email) {
      console.error('Could not fetch email content')
      return jsonResponse(
        { received: true, processed: false, error: 'Could not fetch email' },
        200,
        origin
      )
    }

    // Forward to support
    const forwarded = await forwardEmail(email, payload.data.to[0], resendApiKey)

    return jsonResponse(
      {
        received: true,
        processed: true,
        forwarded,
        email_id: emailId,
      },
      200,
      origin
    )
  } catch (err) {
    console.error('Webhook error:', err)
    return errorResponse('Invalid request', 400, undefined, origin)
  }
})

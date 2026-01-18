/**
 * Inbound Email Webhook Handler
 * @module email-inbound
 *
 * Receives inbound emails from Resend and forwards them to support@smithhorn.ca
 */

import { handleCorsPreflightRequest, jsonResponse, errorResponse } from '../_shared/cors.ts'

// Resend inbound email webhook payload
// For email.received, the data contains the full email content directly
interface ResendInboundPayload {
  type: string
  created_at: string
  data: {
    id: string
    from: string
    to: string[]
    subject: string
    text?: string
    html?: string
    date: string
    thread_id?: string
    in_reply_to?: string
  }
}

// Forward email to support
async function forwardEmail(
  emailData: ResendInboundPayload['data'],
  apiKey: string
): Promise<boolean> {
  const originalTo = emailData.to[0] || 'unknown@skillsmith.app'

  const forwardedHtml = `
    <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
      <p style="margin: 0; color: #666;">
        <strong>Forwarded inbound email</strong><br/>
        From: ${emailData.from}<br/>
        To: ${originalTo}<br/>
        Subject: ${emailData.subject}
      </p>
    </div>
    <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;"/>
    ${emailData.html || `<pre>${emailData.text || 'No content'}</pre>`}
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
        reply_to: emailData.from,
        subject: `[Fwd] ${emailData.subject}`,
        html: forwardedHtml,
        text: `Forwarded from: ${emailData.from}\nTo: ${originalTo}\n\n${emailData.text || 'No content'}`,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Failed to forward email:', errorText)
      return false
    }

    const result = await response.json()
    console.log('Email forwarded successfully, id:', result.id)
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

  if (!resendApiKey) {
    console.error('RESEND_API_KEY not configured')
    return errorResponse('Server configuration error', 500, undefined, origin)
  }

  try {
    const rawBody = await req.text()
    console.log('Received webhook request, body length:', rawBody.length)

    // Log the raw payload for debugging (first 500 chars)
    console.log('Payload preview:', rawBody.substring(0, 500))

    const payload: ResendInboundPayload = JSON.parse(rawBody)
    console.log('Webhook type:', payload.type)
    console.log(
      'Email data:',
      JSON.stringify({
        id: payload.data?.id,
        from: payload.data?.from,
        to: payload.data?.to,
        subject: payload.data?.subject,
        hasText: !!payload.data?.text,
        hasHtml: !!payload.data?.html,
      })
    )

    // Only process email.received events
    if (payload.type !== 'email.received') {
      console.log('Ignoring event type:', payload.type)
      return jsonResponse({ received: true, processed: false }, 200, origin)
    }

    // Check if we have the required data
    if (!payload.data || !payload.data.from || !payload.data.subject) {
      console.error('Missing required email data in payload')
      return jsonResponse(
        { received: true, processed: false, error: 'Missing email data' },
        200,
        origin
      )
    }

    console.log('Processing inbound email:', payload.data.id)
    console.log('From:', payload.data.from)
    console.log('Subject:', payload.data.subject)

    // Forward to support - email content is already in the payload
    const forwarded = await forwardEmail(payload.data, resendApiKey)

    return jsonResponse(
      {
        received: true,
        processed: true,
        forwarded,
        email_id: payload.data.id,
      },
      200,
      origin
    )
  } catch (err) {
    console.error('Webhook error:', err)
    return errorResponse('Invalid request', 400, undefined, origin)
  }
})

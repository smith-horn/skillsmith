/**
 * POST /v1/alert-notify - Send alert notifications
 * @module alert-notify
 *
 * SMI-1617: Alert notification endpoint for failed jobs
 *
 * Sends email alerts when workflows or Edge Functions fail.
 * Used by GitHub Actions to notify on job failures.
 *
 * Request Body:
 * - type: Alert type (e.g., "indexer_failed", "refresh_failed")
 * - message: Alert message/details
 * - workflow?: GitHub workflow name
 * - runId?: GitHub Actions run ID
 * - runUrl?: Link to the failed run
 */

import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

import { createSupabaseAdminClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

import { sendEmail } from '../_shared/email.ts'

/**
 * Request body schema
 */
interface AlertRequest {
  type: string
  message: string
  workflow?: string
  runId?: string
  runUrl?: string
}

const ALERT_RECIPIENTS = ['support@skillsmith.app']

/**
 * Generate alert email HTML
 */
function generateAlertHtml(alert: AlertRequest): string {
  const workflowInfo = alert.workflow
    ? `<p style="margin: 0 0 8px 0;"><strong>Workflow:</strong> ${alert.workflow}</p>`
    : ''

  const runLink = alert.runUrl
    ? `<p style="margin: 16px 0 0 0;"><a href="${alert.runUrl}" style="color: #6366f1;">View Run Details →</a></p>`
    : ''

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Skillsmith Alert</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);">
    <div style="background-color: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h1 style="color: #dc2626; margin: 0 0 16px 0; font-size: 20px; font-weight: 600;">
        🚨 Alert: ${alert.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
      </h1>
      ${workflowInfo}
      <p style="margin: 0; color: #7f1d1d;">${alert.message}</p>
      ${runLink}
    </div>

    <p style="margin: 0; font-size: 12px; color: #9ca3af; text-align: center;">
      Timestamp: ${new Date().toISOString()}
    </p>
  </div>
</body>
</html>
`
}

/**
 * Generate plain text alert
 */
function generateAlertText(alert: AlertRequest): string {
  const workflowInfo = alert.workflow ? `Workflow: ${alert.workflow}\n` : ''
  const runInfo = alert.runUrl ? `\nView details: ${alert.runUrl}` : ''

  return `🚨 SKILLSMITH ALERT
${'='.repeat(40)}

Type: ${alert.type}
${workflowInfo}
${alert.message}
${runInfo}

Timestamp: ${new Date().toISOString()}
`
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest()
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  const requestId = getRequestId(req.headers)
  const origin = req.headers.get('origin')
  logInvocation('alert-notify', requestId)

  try {
    const body: AlertRequest = await req.json()

    if (!body.type || !body.message) {
      return errorResponse('Missing required fields: type, message', 400)
    }

    const supabase = createSupabaseAdminClient()

    // Send email
    const html = generateAlertHtml(body)
    const text = generateAlertText(body)
    const subject = `🚨 Skillsmith Alert: ${body.type.replace(/_/g, ' ')}`

    let emailSent = false
    for (const recipient of ALERT_RECIPIENTS) {
      const sent = await sendEmail(recipient, subject, html, text)
      if (sent) emailSent = true
    }

    // Log to audit_logs
    await supabase.from('audit_logs').insert({
      event_type: 'alert:sent',
      actor: 'system',
      action: 'send_alert',
      result: emailSent ? 'success' : 'failed',
      metadata: {
        request_id: requestId,
        alert_type: body.type,
        workflow: body.workflow,
        run_id: body.runId,
        email_sent: emailSent,
      },
    })

    const response = jsonResponse({
      data: {
        sent: emailSent,
        recipients: ALERT_RECIPIENTS,
      },
      meta: {
        request_id: requestId,
        timestamp: new Date().toISOString(),
      },
    })

    const headers = new Headers(response.headers)
    Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    headers.set('X-Request-ID', requestId)

    return new Response(response.body, {
      status: response.status,
      headers,
    })
  } catch (error) {
    console.error('Alert notify error:', error)
    return errorResponse('Internal server error', 500, {
      request_id: requestId,
    })
  }
})

/**
 * POST /v1/ops-report - Weekly operations report
 * @module ops-report
 *
 * SMI-1617: Weekly operations report with email notification
 *
 * Compiles weekly metrics from:
 * - Indexer runs (skills indexed, failures)
 * - Metadata refresh runs
 * - Skill database stats
 * - Error rates
 *
 * Sends report to support@skillsmith.app via Resend.
 *
 * Request Body (optional):
 * - dryRun: If true, return report but don't send email (default: false)
 * - days: Number of days to include (default: 7)
 * - recipients: Override email recipients (default: support@skillsmith.app)
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
interface ReportRequest {
  dryRun?: boolean
  days?: number
  recipients?: string[]
}

/**
 * Audit log entry
 */
interface AuditLogEntry {
  id: string
  event_type: string
  result: string
  metadata: Record<string, unknown>
  created_at: string
}

/**
 * Report data structure
 */
interface OpsReport {
  period: {
    start: string
    end: string
    days: number
  }
  indexer: {
    runs: number
    skillsIndexed: number
    skillsUpdated: number
    failures: number
    errors: string[]
  }
  refresh: {
    runs: number
    skillsProcessed: number
    skillsUpdated: number
    skillsSkipped: number
    failures: number
    errors: string[]
  }
  database: {
    totalSkills: number
    verifiedSkills: number
    communitySkills: number
    experimentalSkills: number
  }
  alerts: string[]
}

/**
 * Generate HTML email content
 */
function generateReportHtml(report: OpsReport): string {
  const alertsHtml =
    report.alerts.length > 0
      ? `
    <div style="background-color: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <h3 style="color: #dc2626; margin: 0 0 12px 0; font-size: 16px;">⚠️ Alerts</h3>
      <ul style="margin: 0; padding-left: 20px; color: #7f1d1d;">
        ${report.alerts.map((a) => `<li>${a}</li>`).join('\n')}
      </ul>
    </div>
  `
      : `
    <div style="background-color: #f0fdf4; border: 1px solid #22c55e; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="color: #166534; margin: 0;">✅ No alerts - all systems operating normally</p>
    </div>
  `

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Skillsmith Weekly Ops Report</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);">
    <!-- Header -->
    <div style="text-align: center; margin-bottom: 32px;">
      <h1 style="color: #6366f1; margin: 0 0 8px 0; font-size: 24px; font-weight: 700;">
        📊 Weekly Ops Report
      </h1>
      <p style="color: #6b7280; margin: 0; font-size: 14px;">
        ${report.period.start} - ${report.period.end}
      </p>
    </div>

    ${alertsHtml}

    <!-- Indexer Stats -->
    <div style="margin-bottom: 24px;">
      <h2 style="color: #1a1a1a; margin: 0 0 16px 0; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">
        🔍 Indexer
      </h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Runs</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.indexer.runs}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Skills Indexed (new)</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.indexer.skillsIndexed}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Skills Updated</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.indexer.skillsUpdated}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Failures</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500; color: ${report.indexer.failures > 0 ? '#dc2626' : '#16a34a'};">${report.indexer.failures}</td>
        </tr>
      </table>
    </div>

    <!-- Refresh Stats -->
    <div style="margin-bottom: 24px;">
      <h2 style="color: #1a1a1a; margin: 0 0 16px 0; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">
        🔄 Metadata Refresh
      </h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Runs</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.refresh.runs}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Skills Processed</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.refresh.skillsProcessed}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Skills Updated</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.refresh.skillsUpdated}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Skipped (deleted repos)</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.refresh.skillsSkipped}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Failures</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500; color: ${report.refresh.failures > 0 ? '#dc2626' : '#16a34a'};">${report.refresh.failures}</td>
        </tr>
      </table>
    </div>

    <!-- Database Stats -->
    <div style="margin-bottom: 24px;">
      <h2 style="color: #1a1a1a; margin: 0 0 16px 0; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">
        📦 Database
      </h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Total Skills</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.database.totalSkills.toLocaleString()}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Verified</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500; color: #16a34a;">${report.database.verifiedSkills}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Community</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.database.communitySkills}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Experimental</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${report.database.experimentalSkills}</td>
        </tr>
      </table>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
    <p style="margin: 0; font-size: 12px; color: #9ca3af; text-align: center;">
      Generated: ${new Date().toISOString()}<br>
      <a href="https://supabase.com/dashboard/project/vrcnzpmndtroqxxoqkzy/functions" style="color: #6366f1;">View Functions Dashboard</a>
    </p>
  </div>
</body>
</html>
`
}

/**
 * Generate plain text email content
 */
function generateReportText(report: OpsReport): string {
  const alertsText =
    report.alerts.length > 0
      ? `⚠️ ALERTS\n${'='.repeat(40)}\n${report.alerts.map((a) => `• ${a}`).join('\n')}\n\n`
      : '✅ No alerts - all systems operating normally\n\n'

  return `SKILLSMITH WEEKLY OPS REPORT
${report.period.start} - ${report.period.end}
${'='.repeat(40)}

${alertsText}
INDEXER
-------
Runs: ${report.indexer.runs}
Skills Indexed (new): ${report.indexer.skillsIndexed}
Skills Updated: ${report.indexer.skillsUpdated}
Failures: ${report.indexer.failures}

METADATA REFRESH
----------------
Runs: ${report.refresh.runs}
Skills Processed: ${report.refresh.skillsProcessed}
Skills Updated: ${report.refresh.skillsUpdated}
Skipped (deleted repos): ${report.refresh.skillsSkipped}
Failures: ${report.refresh.failures}

DATABASE
--------
Total Skills: ${report.database.totalSkills.toLocaleString()}
Verified: ${report.database.verifiedSkills}
Community: ${report.database.communitySkills}
Experimental: ${report.database.experimentalSkills}

---
Generated: ${new Date().toISOString()}
`
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest()
  }

  // Only allow POST requests (or GET for manual trigger)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return errorResponse('Method not allowed', 405)
  }

  const requestId = getRequestId(req.headers)
  const origin = req.headers.get('origin')
  logInvocation('ops-report', requestId)

  try {
    // Parse request body (optional)
    let body: ReportRequest = {}
    if (req.method === 'POST') {
      try {
        body = await req.json()
      } catch {
        // Empty body is OK
      }
    }

    const dryRun = body.dryRun ?? false
    const days = Math.min(Math.max(body.days || 7, 1), 30)
    const recipients = body.recipients || ['support@skillsmith.app']

    const supabase = createSupabaseAdminClient()

    // Calculate date range
    const endDate = new Date()
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    // Query indexer audit logs
    const { data: indexerLogs } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('event_type', 'indexer:run')
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false })

    // Query refresh audit logs
    const { data: refreshLogs } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('event_type', 'refresh:run')
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false })

    // Query skill counts by trust tier
    const { count: totalSkills } = await supabase
      .from('skills')
      .select('*', { count: 'exact', head: true })

    const { count: verifiedSkills } = await supabase
      .from('skills')
      .select('*', { count: 'exact', head: true })
      .eq('trust_tier', 'verified')

    const { count: communitySkills } = await supabase
      .from('skills')
      .select('*', { count: 'exact', head: true })
      .eq('trust_tier', 'community')

    const { count: experimentalSkills } = await supabase
      .from('skills')
      .select('*', { count: 'exact', head: true })
      .eq('trust_tier', 'experimental')

    // Aggregate indexer stats
    const indexerStats = {
      runs: indexerLogs?.length || 0,
      skillsIndexed: 0,
      skillsUpdated: 0,
      failures: 0,
      errors: [] as string[],
    }

    for (const log of (indexerLogs as AuditLogEntry[]) || []) {
      const meta = log.metadata || {}
      indexerStats.skillsIndexed += (meta.indexed as number) || 0
      indexerStats.skillsUpdated += (meta.updated as number) || 0
      indexerStats.failures += (meta.failed as number) || 0
      if (log.result !== 'success') {
        indexerStats.errors.push(`${log.created_at}: ${log.result}`)
      }
    }

    // Aggregate refresh stats
    const refreshStats = {
      runs: refreshLogs?.length || 0,
      skillsProcessed: 0,
      skillsUpdated: 0,
      skillsSkipped: 0,
      failures: 0,
      errors: [] as string[],
    }

    for (const log of (refreshLogs as AuditLogEntry[]) || []) {
      const meta = log.metadata || {}
      refreshStats.skillsProcessed += (meta.processed as number) || 0
      refreshStats.skillsUpdated += (meta.updated as number) || 0
      refreshStats.skillsSkipped += (meta.skipped as number) || 0
      refreshStats.failures += (meta.failed as number) || 0
      if (log.result !== 'success') {
        refreshStats.errors.push(`${log.created_at}: ${log.result}`)
      }
    }

    // Generate alerts
    const alerts: string[] = []

    if (indexerStats.runs === 0) {
      alerts.push('No indexer runs in the past week - check GitHub Actions workflow')
    }
    if (indexerStats.failures > 5) {
      alerts.push(`High indexer failure count: ${indexerStats.failures} failures`)
    }
    if (refreshStats.runs < days * 20) {
      // Should be ~24 runs/day with hourly schedule
      alerts.push(
        `Low refresh run count: ${refreshStats.runs} (expected ~${days * 24} with hourly schedule)`
      )
    }
    if (refreshStats.failures > 10) {
      alerts.push(`High refresh failure count: ${refreshStats.failures} failures`)
    }
    const skipRate =
      refreshStats.skillsProcessed > 0
        ? (refreshStats.skillsSkipped / refreshStats.skillsProcessed) * 100
        : 0
    if (skipRate > 20) {
      alerts.push(`High skip rate in refresh: ${skipRate.toFixed(1)}% - many deleted repos`)
    }

    // Build report
    const report: OpsReport = {
      period: {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
        days,
      },
      indexer: indexerStats,
      refresh: refreshStats,
      database: {
        totalSkills: totalSkills || 0,
        verifiedSkills: verifiedSkills || 0,
        communitySkills: communitySkills || 0,
        experimentalSkills: experimentalSkills || 0,
      },
      alerts,
    }

    // Send email if not dry run
    let emailSent = false
    if (!dryRun) {
      const html = generateReportHtml(report)
      const text = generateReportText(report)
      const subject =
        alerts.length > 0
          ? `⚠️ Skillsmith Ops Report - ${alerts.length} Alert(s)`
          : `✅ Skillsmith Ops Report - ${report.period.start} to ${report.period.end}`

      for (const recipient of recipients) {
        const sent = await sendEmail(recipient, subject, html, text)
        if (sent) emailSent = true
      }

      // Log to audit_logs
      await supabase.from('audit_logs').insert({
        event_type: 'ops-report:sent',
        actor: 'system',
        action: 'send_report',
        result: emailSent ? 'success' : 'failed',
        metadata: {
          request_id: requestId,
          days,
          recipients,
          alert_count: alerts.length,
          email_sent: emailSent,
        },
      })
    }

    const response = jsonResponse({
      data: {
        report,
        emailSent: dryRun ? null : emailSent,
        recipients: dryRun ? null : recipients,
      },
      meta: {
        dry_run: dryRun,
        days,
        request_id: requestId,
        timestamp: new Date().toISOString(),
      },
    })

    // Add CORS headers
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
    console.error('Ops report error:', error)
    return errorResponse('Internal server error', 500, {
      request_id: requestId,
    })
  }
})

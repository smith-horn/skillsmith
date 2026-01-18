/**
 * Contact Form Submission Handler
 * @module contact-submit
 *
 * Handles contact form submissions from the website.
 * Stores submissions in the database and sends email notifications via Resend.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCorsPreflightRequest, jsonResponse, errorResponse } from '../_shared/cors.ts'

interface ContactSubmission {
  name: string
  email: string
  company?: string
  topic: string
  message: string
}

const TOPIC_LABELS: Record<string, string> = {
  general: 'General Inquiry',
  support: 'Technical Support',
  sales: 'Sales / Pricing',
  enterprise: 'Enterprise Plans',
  partnership: 'Partnership Opportunity',
  feedback: 'Product Feedback',
  bug: 'Bug Report',
  other: 'Other',
}

async function sendEmailNotification(submission: ContactSubmission, submissionId: string) {
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  if (!resendApiKey) {
    console.warn('RESEND_API_KEY not configured - skipping email notification')
    return { success: false, error: 'Email not configured' }
  }

  const topicLabel = TOPIC_LABELS[submission.topic] || submission.topic

  const emailHtml = `
    <h2>New Contact Form Submission</h2>
    <p><strong>From:</strong> ${submission.name} &lt;${submission.email}&gt;</p>
    ${submission.company ? `<p><strong>Company:</strong> ${submission.company}</p>` : ''}
    <p><strong>Topic:</strong> ${topicLabel}</p>
    <p><strong>Submission ID:</strong> ${submissionId}</p>
    <hr />
    <h3>Message:</h3>
    <p style="white-space: pre-wrap;">${submission.message}</p>
    <hr />
    <p style="color: #666; font-size: 12px;">
      This message was sent from the Skillsmith contact form.<br />
      Reply directly to this email to respond to ${submission.name}.
    </p>
  `

  const emailText = `
New Contact Form Submission

From: ${submission.name} <${submission.email}>
${submission.company ? `Company: ${submission.company}` : ''}
Topic: ${topicLabel}
Submission ID: ${submissionId}

Message:
${submission.message}

---
This message was sent from the Skillsmith contact form.
Reply directly to this email to respond to ${submission.name}.
  `.trim()

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skillsmith <noreply@skillsmith.app>',
        to: ['support@smithhorn.ca'],
        reply_to: submission.email,
        subject: `[Skillsmith] ${topicLabel}: ${submission.name}`,
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
    console.log('Email sent successfully:', result.id)
    return { success: true, emailId: result.id }
  } catch (err) {
    console.error('Failed to send email:', err)
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
    const body: ContactSubmission = await req.json()

    // Validate required fields
    if (!body.name || !body.email || !body.topic || !body.message) {
      return errorResponse(
        'Missing required fields: name, email, topic, message',
        400,
        undefined,
        origin
      )
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(body.email)) {
      return errorResponse('Invalid email format', 400, undefined, origin)
    }

    // Validate topic
    const validTopics = Object.keys(TOPIC_LABELS)
    if (!validTopics.includes(body.topic)) {
      return errorResponse('Invalid topic', 400, undefined, origin)
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Store submission in database
    const { data, error } = await supabase
      .from('contact_submissions')
      .insert({
        name: body.name.trim(),
        email: body.email.trim().toLowerCase(),
        company: body.company?.trim() || null,
        topic: body.topic,
        message: body.message.trim(),
        status: 'new',
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) {
      console.error('Database error:', error)
      if (error.code === '42P01') {
        console.warn('contact_submissions table does not exist - submission not stored')
        return jsonResponse(
          {
            success: true,
            message: 'Thank you for your message. We will get back to you soon.',
          },
          200,
          origin
        )
      }
      return errorResponse('Failed to submit message', 500, undefined, origin)
    }

    // Send email notification (don't fail if email fails)
    const emailResult = await sendEmailNotification(body, data?.id || 'unknown')
    if (!emailResult.success) {
      console.warn('Email notification failed, but submission was stored:', emailResult.error)
    }

    return jsonResponse(
      {
        success: true,
        message: 'Thank you for your message. We will get back to you soon.',
        id: data?.id,
      },
      200,
      origin
    )
  } catch (err) {
    console.error('Contact form error:', err)
    return errorResponse('Invalid request', 400, undefined, origin)
  }
})

/**
 * Contact Form Submission Handler
 * @module contact-submit
 *
 * Handles contact form submissions from the website.
 * Stores submissions in the database for review.
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
    const validTopics = [
      'general',
      'support',
      'sales',
      'enterprise',
      'partnership',
      'feedback',
      'bug',
      'other',
    ]
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
      // If table doesn't exist, still return success to user
      // but log for admin attention
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

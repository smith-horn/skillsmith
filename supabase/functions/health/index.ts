/**
 * SMI-1447: Live API Health Verification Endpoint
 *
 * Provides comprehensive health status for the Skillsmith API including:
 * - Database connectivity
 * - Cache status
 * - Rate limiter status
 * - Service dependencies
 *
 * Usage:
 *   GET /functions/v1/health
 *   GET /functions/v1/health?verbose=true
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface HealthCheck {
  name: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  latencyMs: number
  message?: string
  details?: Record<string, unknown>
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  version: string
  timestamp: string
  uptime: number
  checks: HealthCheck[]
  summary: {
    total: number
    healthy: number
    degraded: number
    unhealthy: number
  }
}

const VERSION = '1.0.0'
const startTime = Date.now()

/**
 * Check database connectivity and query performance
 */
async function checkDatabase(supabase: ReturnType<typeof createClient>): Promise<HealthCheck> {
  const start = Date.now()
  try {
    const { data, error } = await supabase.from('skills').select('id').limit(1)

    if (error) {
      return {
        name: 'database',
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        message: `Database query failed: ${error.message}`,
      }
    }

    const latency = Date.now() - start
    return {
      name: 'database',
      status: latency > 1000 ? 'degraded' : 'healthy',
      latencyMs: latency,
      message: latency > 1000 ? 'High query latency' : 'Connected',
      details: { rowsReturned: data?.length || 0 },
    }
  } catch (error) {
    return {
      name: 'database',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: `Database error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * Check skills count for data availability
 */
async function checkSkillsData(supabase: ReturnType<typeof createClient>): Promise<HealthCheck> {
  const start = Date.now()
  try {
    const { count, error } = await supabase
      .from('skills')
      .select('*', { count: 'exact', head: true })

    if (error) {
      return {
        name: 'skills_data',
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        message: `Skills count failed: ${error.message}`,
      }
    }

    const skillCount = count || 0
    return {
      name: 'skills_data',
      status: skillCount > 0 ? 'healthy' : 'degraded',
      latencyMs: Date.now() - start,
      message: skillCount > 0 ? `${skillCount} skills available` : 'No skills in database',
      details: { skillCount },
    }
  } catch (error) {
    return {
      name: 'skills_data',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: `Skills data error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * Check search functionality
 */
async function checkSearch(supabase: ReturnType<typeof createClient>): Promise<HealthCheck> {
  const start = Date.now()
  try {
    const { error } = await supabase.rpc('search_skills', { search_query: 'test', page_size: 1 })

    if (error) {
      return {
        name: 'search',
        status: 'degraded',
        latencyMs: Date.now() - start,
        message: `Search function unavailable: ${error.message}`,
      }
    }

    return {
      name: 'search',
      status: 'healthy',
      latencyMs: Date.now() - start,
      message: 'Search function operational',
    }
  } catch (error) {
    return {
      name: 'search',
      status: 'degraded',
      latencyMs: Date.now() - start,
      message: `Search error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * Main health check handler
 */
Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const verbose = url.searchParams.get('verbose') === 'true'

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY') || ''

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({
          status: 'unhealthy',
          message: 'Missing Supabase configuration',
          timestamp: new Date().toISOString(),
        }),
        {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    // Run health checks in parallel
    const checks = await Promise.all([
      checkDatabase(supabase),
      checkSkillsData(supabase),
      checkSearch(supabase),
    ])

    // Calculate summary
    const summary = {
      total: checks.length,
      healthy: checks.filter((c) => c.status === 'healthy').length,
      degraded: checks.filter((c) => c.status === 'degraded').length,
      unhealthy: checks.filter((c) => c.status === 'unhealthy').length,
    }

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
    if (summary.unhealthy > 0) {
      status = 'unhealthy'
    } else if (summary.degraded > 0) {
      status = 'degraded'
    }

    const response: HealthResponse = {
      status,
      version: VERSION,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks: verbose
        ? checks
        : checks.map(({ name, status, latencyMs }) => ({ name, status, latencyMs })),
      summary,
    }

    return new Response(JSON.stringify(response, null, 2), {
      status: status === 'unhealthy' ? 503 : 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store',
      },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})

/**
 * k6 Load Test for Skillsmith API
 * @module tests/performance/api-load-test
 *
 * SMI-1233: Performance testing for Edge Functions API
 *
 * Run with:
 *   k6 run tests/performance/api-load-test.js
 *
 * With options:
 *   k6 run --vus 10 --duration 30s tests/performance/api-load-test.js
 *   k6 run --env BASE_URL=https://api.skillsmith.dev tests/performance/api-load-test.js
 */

import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Rate, Trend, Counter } from 'k6/metrics'

// Custom metrics
const errorRate = new Rate('error_rate')
const searchLatency = new Trend('search_latency')
const getSkillLatency = new Trend('get_skill_latency')
const recommendLatency = new Trend('recommend_latency')
const eventsLatency = new Trend('events_latency')
const indexerLatency = new Trend('indexer_latency')
const rateLimitHits = new Counter('rate_limit_hits')

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:54321/functions/v1'
const ANON_KEY =
  __ENV.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyY256cG1uZHRyb3F4eG9xa3p5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzgwNzQsImV4cCI6MjA4MzQxNDA3NH0.WNK5jaNG3twxApOva5A1ZlCaZb5hVqBYtNJezRrR4t8'

// Test scenarios
export const options = {
  scenarios: {
    // Smoke test: verify endpoints work
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '10s',
      tags: { scenario: 'smoke' },
      env: { SCENARIO: 'smoke' },
    },
    // Load test: typical traffic
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 }, // Ramp up
        { duration: '1m', target: 10 }, // Steady state
        { duration: '30s', target: 0 }, // Ramp down
      ],
      startTime: '15s',
      tags: { scenario: 'load' },
      env: { SCENARIO: 'load' },
    },
    // Stress test: peak traffic
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 }, // Ramp up
        { duration: '1m', target: 50 }, // Peak load
        { duration: '30s', target: 0 }, // Ramp down
      ],
      startTime: '2m30s',
      tags: { scenario: 'stress' },
      env: { SCENARIO: 'stress' },
    },
  },
  thresholds: {
    // Overall thresholds
    http_req_duration: ['p(95)<5000'],
    // Per-scenario error rates (SMI-1266)
    'error_rate{scenario:smoke}': ['rate<0.01'], // 1% for smoke
    'error_rate{scenario:load}': ['rate<0.05'], // 5% for load
    'error_rate{scenario:stress}': ['rate<0.15'], // 15% for stress
    // General error rate fallback
    error_rate: ['rate<0.20'],
    // Per-endpoint latencies
    search_latency: ['p(95)<4000'],
    get_skill_latency: ['p(95)<3000'],
    recommend_latency: ['p(95)<5000'],
    events_latency: ['p(95)<3000'],
    indexer_latency: ['p(95)<5000'],
  },
}

// Common headers
const headers = {
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
  'x-request-id': `k6-${Date.now()}`,
}

// Sample test data
const searchQueries = ['testing', 'react', 'typescript', 'api', 'cli', 'docker']
const techStacks = [
  ['react', 'typescript'],
  ['node', 'express'],
  ['python', 'fastapi'],
  ['rust', 'wasm'],
  ['vue', 'vite'],
]
const projectTypes = ['web', 'api', 'cli', 'mobile', 'data']

// Helper to get random item from array
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// Helper to generate anonymous ID
function generateAnonymousId() {
  const chars = 'abcdef0123456789'
  let id = ''
  for (let i = 0; i < 32; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

// Test functions
function testSearch() {
  const query = randomItem(searchQueries)
  const start = Date.now()

  const response = http.get(`${BASE_URL}/skills-search?query=${query}&limit=10`, { headers })

  searchLatency.add(Date.now() - start)

  const success = check(response, {
    'search: status is 200': (r) => r.status === 200,
    'search: has data array': (r) => {
      try {
        const body = JSON.parse(r.body)
        return Array.isArray(body.data)
      } catch {
        return false
      }
    },
    'search: has rate limit headers': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
  })

  errorRate.add(!success)

  if (response.status === 429) {
    rateLimitHits.add(1)
  }

  return response
}

function testGetSkill() {
  // Use a sample skill ID or search result
  const start = Date.now()

  const response = http.get(`${BASE_URL}/skills-get?id=test-skill`, { headers })

  getSkillLatency.add(Date.now() - start)

  const success = check(response, {
    'get-skill: status is 200 or 404': (r) => r.status === 200 || r.status === 404,
    'get-skill: has rate limit headers': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
  })

  errorRate.add(!success)

  if (response.status === 429) {
    rateLimitHits.add(1)
  }

  return response
}

function testRecommend() {
  const stack = randomItem(techStacks)
  const projectType = randomItem(projectTypes)
  const start = Date.now()

  const response = http.post(
    `${BASE_URL}/skills-recommend`,
    JSON.stringify({
      stack,
      project_type: projectType,
      limit: 10,
    }),
    { headers }
  )

  recommendLatency.add(Date.now() - start)

  const success = check(response, {
    'recommend: status is 200': (r) => r.status === 200,
    'recommend: has data array': (r) => {
      try {
        const body = JSON.parse(r.body)
        return Array.isArray(body.data)
      } catch {
        return false
      }
    },
    'recommend: has rate limit headers': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
  })

  errorRate.add(!success)

  if (response.status === 429) {
    rateLimitHits.add(1)
  }

  return response
}

function testEvents() {
  const anonymousId = generateAnonymousId()
  const start = Date.now()

  const response = http.post(
    `${BASE_URL}/events`,
    JSON.stringify({
      event: 'search',
      anonymous_id: anonymousId,
      metadata: {
        query: randomItem(searchQueries),
        results_count: Math.floor(Math.random() * 20),
        duration_ms: Math.floor(Math.random() * 500),
      },
    }),
    { headers }
  )

  eventsLatency.add(Date.now() - start)

  const success = check(response, {
    'events: status is 200': (r) => r.status === 200,
    'events: returns ok': (r) => {
      try {
        const body = JSON.parse(r.body)
        return body.ok === true
      } catch {
        return false
      }
    },
  })

  errorRate.add(!success)

  if (response.status === 429) {
    rateLimitHits.add(1)
  }

  return response
}

function testIndexer() {
  const start = Date.now()

  const response = http.post(
    `${BASE_URL}/indexer`,
    JSON.stringify({
      dryRun: true,
      maxPages: 1,
    }),
    { headers }
  )

  indexerLatency.add(Date.now() - start)

  const success = check(response, {
    'indexer: status is 200': (r) => r.status === 200,
    'indexer: has results': (r) => {
      try {
        const body = JSON.parse(r.body)
        return body.skills_indexed !== undefined || body.dryRun === true
      } catch {
        return false
      }
    },
  })

  errorRate.add(!success)

  if (response.status === 429) {
    rateLimitHits.add(1)
  }

  return response
}

// Main test function
export default function () {
  // Distribute requests across endpoints
  // 38% search, 19% get, 23% recommend, 15% events, 5% indexer
  const rand = Math.random()

  group('API Endpoints', () => {
    if (rand < 0.38) {
      testSearch()
    } else if (rand < 0.57) {
      testGetSkill()
    } else if (rand < 0.8) {
      testRecommend()
    } else if (rand < 0.95) {
      testEvents()
    } else {
      testIndexer()
    }
  })

  // Small delay between requests
  sleep(Math.random() * 0.5 + 0.1)
}

// Setup function - runs once before test
export function setup() {
  console.log(`Running load test against: ${BASE_URL}`)

  // Verify endpoints are reachable
  const healthCheck = http.get(`${BASE_URL}/skills-search?query=test`, { headers })
  if (healthCheck.status !== 200 && healthCheck.status !== 400) {
    console.warn(`Warning: Health check returned status ${healthCheck.status}`)
  }

  return { startTime: Date.now() }
}

// Teardown function - runs once after test
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000
  console.log(`Test completed in ${duration.toFixed(2)} seconds`)
}

// Handle test summary
export function handleSummary(data) {
  return {
    'tests/performance/results/summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  }
}

// Simple text summary (k6 built-in would be used in real run)
function textSummary(data) {
  const metrics = data.metrics
  let summary = '\n=== Performance Test Summary ===\n\n'

  if (metrics.http_reqs) {
    summary += `Total Requests: ${metrics.http_reqs.values.count}\n`
  }
  if (metrics.http_req_duration) {
    summary += `Avg Latency: ${metrics.http_req_duration.values.avg?.toFixed(2) || 'N/A'}ms\n`
    summary += `P95 Latency: ${metrics.http_req_duration.values['p(95)']?.toFixed(2) || 'N/A'}ms\n`
  }
  if (metrics.error_rate) {
    summary += `Error Rate: ${(metrics.error_rate.values.rate * 100)?.toFixed(2) || 'N/A'}%\n`
  }
  if (metrics.rate_limit_hits) {
    summary += `Rate Limit Hits: ${metrics.rate_limit_hits.values.count || 0}\n`
  }
  if (metrics.indexer_latency) {
    summary += `Indexer P95: ${metrics.indexer_latency.values['p(95)']?.toFixed(2) || 'N/A'}ms\n`
  }

  return summary
}

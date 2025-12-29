/**
 * SMI-740: Health Check and Readiness Integration Tests
 *
 * Tests for health and readiness endpoints:
 * - /health: Quick liveness check
 * - /ready: Deep readiness check with dependency verification
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  HealthCheck,
  checkHealth,
  createHealthCheck,
  formatHealthResponse,
  type HealthResponse,
} from '../src/health/healthCheck.js'
import {
  ReadinessCheck,
  checkReadiness,
  createReadinessCheck,
  formatReadinessResponse,
  type ReadinessResponse,
} from '../src/health/readinessCheck.js'
import { checkAll } from '../src/health/index.js'

describe('Health Check (SMI-740)', () => {
  describe('HealthCheck class', () => {
    it('should return ok status when healthy', async () => {
      const healthCheck = new HealthCheck()
      const result = await healthCheck.check()

      expect(result.status).toBe('ok')
      expect(result.uptime).toBeGreaterThanOrEqual(0)
      expect(result.version).toBeDefined()
      expect(result.timestamp).toBeDefined()
    })

    it('should include custom version', async () => {
      const healthCheck = new HealthCheck({ version: '1.2.3' })
      const result = await healthCheck.check()

      expect(result.version).toBe('1.2.3')
    })

    it('should return degraded status when custom check fails', async () => {
      const healthCheck = new HealthCheck({
        customCheck: async () => ({ healthy: false, info: { reason: 'Test failure' } }),
      })
      const result = await healthCheck.check()

      expect(result.status).toBe('degraded')
      expect(result.info?.reason).toBe('Test failure')
    })

    it('should handle custom check errors gracefully', async () => {
      const healthCheck = new HealthCheck({
        customCheck: async () => {
          throw new Error('Custom check error')
        },
      })
      const result = await healthCheck.check()

      expect(result.status).toBe('degraded')
      expect(result.info?.customCheckError).toBe('Custom check error')
    })

    it('should calculate uptime correctly', async () => {
      const healthCheck = new HealthCheck()
      const uptime1 = healthCheck.getUptime()

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100))

      const uptime2 = healthCheck.getUptime()
      expect(uptime2).toBeGreaterThanOrEqual(uptime1)
    })

    it('should return boolean from isHealthy', async () => {
      const healthCheck = new HealthCheck()
      const isHealthy = await healthCheck.isHealthy()

      expect(typeof isHealthy).toBe('boolean')
      expect(isHealthy).toBe(true)
    })
  })

  describe('checkHealth function', () => {
    it('should use default health check instance', async () => {
      const result = await checkHealth()

      expect(result.status).toBe('ok')
      expect(result.uptime).toBeGreaterThanOrEqual(0)
    })
  })

  describe('createHealthCheck function', () => {
    it('should create new instance with config', async () => {
      const healthCheck = createHealthCheck({ version: '2.0.0' })
      const result = await healthCheck.check()

      expect(result.version).toBe('2.0.0')
    })
  })

  describe('formatHealthResponse', () => {
    it('should return 200 for ok status', () => {
      const response: HealthResponse = {
        status: 'ok',
        uptime: 100,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      }

      const formatted = formatHealthResponse(response)
      expect(formatted.statusCode).toBe(200)
      expect(formatted.body).toEqual(response)
    })

    it('should return 200 for degraded status', () => {
      const response: HealthResponse = {
        status: 'degraded',
        uptime: 100,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      }

      const formatted = formatHealthResponse(response)
      expect(formatted.statusCode).toBe(200)
    })

    it('should return 503 for unhealthy status', () => {
      const response: HealthResponse = {
        status: 'unhealthy',
        uptime: 100,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      }

      const formatted = formatHealthResponse(response)
      expect(formatted.statusCode).toBe(503)
    })
  })
})

describe('Readiness Check (SMI-740)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)')
  })

  afterEach(() => {
    db.close()
  })

  describe('ReadinessCheck class', () => {
    it('should return ready when database is healthy', async () => {
      const readinessCheck = new ReadinessCheck({ database: db })
      const result = await readinessCheck.check()

      expect(result.ready).toBe(true)
      expect(result.statusCode).toBe(200)
      expect(result.checks).toBeDefined()
      expect(result.totalDuration).toBeGreaterThanOrEqual(0)
    })

    it('should check database connectivity', async () => {
      const readinessCheck = new ReadinessCheck({ database: db })
      const result = await readinessCheck.check()

      const dbCheck = result.checks.find((c) => c.name === 'database')
      expect(dbCheck).toBeDefined()
      expect(dbCheck?.status).toBe('ok')
      expect(dbCheck?.responseTime).toBeGreaterThanOrEqual(0)
    })

    it('should return degraded when database is not configured', async () => {
      const readinessCheck = new ReadinessCheck()
      const result = await readinessCheck.check()

      const dbCheck = result.checks.find((c) => c.name === 'database')
      expect(dbCheck?.status).toBe('degraded')
    })

    it('should return not ready when database fails', async () => {
      // Close the database to simulate failure
      const closedDb = new Database(':memory:')
      closedDb.close()

      const readinessCheck = new ReadinessCheck({ database: closedDb })
      const result = await readinessCheck.check()

      expect(result.ready).toBe(false)
      expect(result.statusCode).toBe(503)
    })

    it('should check cache status', async () => {
      const readinessCheck = new ReadinessCheck({
        database: db,
        cacheCheck: async () => true,
      })
      const result = await readinessCheck.check()

      const cacheCheck = result.checks.find((c) => c.name === 'cache')
      expect(cacheCheck).toBeDefined()
      expect(cacheCheck?.status).toBe('ok')
    })

    it('should report cache failure', async () => {
      const readinessCheck = new ReadinessCheck({
        database: db,
        cacheCheck: async () => false,
      })
      const result = await readinessCheck.check()

      const cacheCheck = result.checks.find((c) => c.name === 'cache')
      expect(cacheCheck?.status).toBe('unhealthy')
      expect(result.ready).toBe(false)
    })

    it('should run custom checks', async () => {
      const readinessCheck = new ReadinessCheck({
        database: db,
        customChecks: [
          {
            name: 'external-api',
            check: async () => ({ ok: true, details: { endpoint: 'https://api.example.com' } }),
          },
        ],
      })
      const result = await readinessCheck.check()

      const customCheck = result.checks.find((c) => c.name === 'external-api')
      expect(customCheck).toBeDefined()
      expect(customCheck?.status).toBe('ok')
      expect(customCheck?.details?.endpoint).toBe('https://api.example.com')
    })

    it('should handle custom check failures', async () => {
      const readinessCheck = new ReadinessCheck({
        database: db,
        customChecks: [
          {
            name: 'failing-check',
            check: async () => {
              throw new Error('Connection refused')
            },
            critical: true,
          },
        ],
      })
      const result = await readinessCheck.check()

      const failingCheck = result.checks.find((c) => c.name === 'failing-check')
      expect(failingCheck?.status).toBe('unhealthy')
      expect(failingCheck?.error).toBe('Connection refused')
      expect(result.ready).toBe(false)
    })

    it('should not fail on non-critical check failure', async () => {
      const readinessCheck = new ReadinessCheck({
        database: db,
        customChecks: [
          {
            name: 'non-critical',
            check: async () => ({ ok: false }),
            critical: false,
          },
        ],
      })
      const result = await readinessCheck.check()

      // Database is ok, so overall should still be ready even with non-critical failure
      expect(result.ready).toBe(true)
    })

    it('should add checks dynamically', async () => {
      const readinessCheck = new ReadinessCheck({ database: db })
      readinessCheck.addCheck(
        'dynamic-check',
        async () => ({ ok: true, details: { added: 'dynamically' } }),
        false
      )

      const result = await readinessCheck.check()
      const dynamicCheck = result.checks.find((c) => c.name === 'dynamic-check')
      expect(dynamicCheck).toBeDefined()
    })

    it('should set database after construction', async () => {
      const readinessCheck = new ReadinessCheck()
      readinessCheck.setDatabase(db)

      const result = await readinessCheck.check()
      const dbCheck = result.checks.find((c) => c.name === 'database')
      expect(dbCheck?.status).toBe('ok')
    })

    it('should return boolean from isReady', async () => {
      const readinessCheck = new ReadinessCheck({ database: db })
      const isReady = await readinessCheck.isReady()

      expect(typeof isReady).toBe('boolean')
      expect(isReady).toBe(true)
    })

    it('should timeout slow checks', async () => {
      const readinessCheck = new ReadinessCheck({
        database: db,
        checkTimeout: 100, // 100ms timeout
        customChecks: [
          {
            name: 'slow-check',
            check: async () => {
              await new Promise((resolve) => setTimeout(resolve, 500))
              return { ok: true }
            },
          },
        ],
      })

      const result = await readinessCheck.check()
      const slowCheck = result.checks.find((c) => c.name === 'slow-check')
      expect(slowCheck?.status).toBe('unhealthy')
      expect(slowCheck?.error).toContain('timed out')
    })
  })

  describe('checkReadiness function', () => {
    it('should use default readiness check instance', async () => {
      const result = await checkReadiness()

      expect(result.checks).toBeDefined()
      expect(result.timestamp).toBeDefined()
    })
  })

  describe('createReadinessCheck function', () => {
    it('should create new instance with config', async () => {
      const readinessCheck = createReadinessCheck({ database: db })
      const result = await readinessCheck.check()

      expect(result.ready).toBe(true)
    })
  })

  describe('formatReadinessResponse', () => {
    it('should return correct status codes', () => {
      const readyResponse: ReadinessResponse = {
        ready: true,
        statusCode: 200,
        timestamp: new Date().toISOString(),
        checks: [],
        totalDuration: 10,
      }

      const notReadyResponse: ReadinessResponse = {
        ready: false,
        statusCode: 503,
        timestamp: new Date().toISOString(),
        checks: [],
        totalDuration: 10,
      }

      expect(formatReadinessResponse(readyResponse).statusCode).toBe(200)
      expect(formatReadinessResponse(notReadyResponse).statusCode).toBe(503)
    })
  })
})

describe('Combined Health and Readiness (SMI-740)', () => {
  describe('checkAll function', () => {
    it('should return both health and readiness', async () => {
      const result = await checkAll()

      expect(result.health).toBeDefined()
      expect(result.health.status).toBeDefined()
      expect(result.health.uptime).toBeGreaterThanOrEqual(0)

      expect(result.readiness).toBeDefined()
      expect(result.readiness.checks).toBeDefined()
      expect(result.readiness.timestamp).toBeDefined()
    })
  })
})

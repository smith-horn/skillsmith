/**
 * @fileoverview Tests for analytics MCP tools
 * @see SMI-3899: Team Usage Analytics MCP Tools (Wave 2b)
 */

import { describe, it, expect } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  executeTeamAnalyticsDashboard,
  executeTeamUsageReport,
  executeAnalyticsDashboard,
  executeUsageReport,
  teamAnalyticsDashboardInputSchema,
  teamUsageReportInputSchema,
  analyticsDashboardInputSchema,
  usageReportInputSchema,
} from './analytics.js'

/** Minimal mock ToolContext — analytics handlers don't use it in MVP */
const mockContext = {} as ToolContext

describe('analytics tools', () => {
  describe('input schema validation', () => {
    it('teamAnalyticsDashboardInputSchema defaults period to 30d', () => {
      const result = teamAnalyticsDashboardInputSchema.parse({})
      expect(result.period).toBe('30d')
    })

    it('teamAnalyticsDashboardInputSchema accepts valid periods', () => {
      expect(teamAnalyticsDashboardInputSchema.parse({ period: '7d' }).period).toBe('7d')
      expect(teamAnalyticsDashboardInputSchema.parse({ period: '90d' }).period).toBe('90d')
    })

    it('teamAnalyticsDashboardInputSchema rejects invalid periods', () => {
      expect(() => teamAnalyticsDashboardInputSchema.parse({ period: '1d' })).toThrow()
    })

    it('teamUsageReportInputSchema defaults format to summary', () => {
      const result = teamUsageReportInputSchema.parse({})
      expect(result.format).toBe('summary')
    })

    it('teamUsageReportInputSchema accepts detailed format', () => {
      const result = teamUsageReportInputSchema.parse({ format: 'detailed' })
      expect(result.format).toBe('detailed')
    })

    it('analyticsDashboardInputSchema defaults includeRecommendations to false', () => {
      const result = analyticsDashboardInputSchema.parse({})
      expect(result.includeRecommendations).toBe(false)
    })

    it('usageReportInputSchema accepts csv format', () => {
      const result = usageReportInputSchema.parse({ format: 'csv' })
      expect(result.format).toBe('csv')
    })

    it('usageReportInputSchema rejects invalid format', () => {
      expect(() => usageReportInputSchema.parse({ format: 'xml' })).toThrow()
    })
  })

  describe('executeTeamAnalyticsDashboard', () => {
    it('returns markdown with expected sections', async () => {
      const input = teamAnalyticsDashboardInputSchema.parse({ period: '30d' })
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain('# Team Analytics Dashboard (30d)')
      expect(result).toContain('## Summary')
      expect(result).toContain('## Top Tools')
      expect(result).toContain('## Per-User Usage')
      expect(result).toContain('## Daily Trend')
    })

    it('adjusts data for 7d period', async () => {
      const input = teamAnalyticsDashboardInputSchema.parse({ period: '7d' })
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain('# Team Analytics Dashboard (7d)')
      expect(result).toContain('Last 7 days')
    })

    it('includes table formatting', async () => {
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      // Verify markdown table delimiters are present
      expect(result).toContain('|------|')
      expect(result).toContain('alice@example.com')
    })
  })

  describe('executeTeamUsageReport', () => {
    it('returns summary format by default', async () => {
      const input = teamUsageReportInputSchema.parse({})
      const result = await executeTeamUsageReport(input, mockContext)

      expect(result).toContain('# Team Usage Report (30d)')
      expect(result).toContain('## Period Summary')
      expect(result).toContain('## Usage by Category')
      // Summary should not have detailed user breakdown
      expect(result).not.toContain('## Detailed Breakdown by User')
    })

    it('returns detailed format with user breakdown', async () => {
      const input = teamUsageReportInputSchema.parse({ format: 'detailed' })
      const result = await executeTeamUsageReport(input, mockContext)

      expect(result).toContain('## Detailed Breakdown by User')
      expect(result).toContain('alice@example.com')
    })

    it('includes period comparison data', async () => {
      const input = teamUsageReportInputSchema.parse({})
      const result = await executeTeamUsageReport(input, mockContext)

      expect(result).toContain('Previous period')
      expect(result).toContain('Change')
    })
  })

  describe('executeAnalyticsDashboard', () => {
    it('returns enterprise dashboard without recommendations by default', async () => {
      const input = analyticsDashboardInputSchema.parse({})
      const result = await executeAnalyticsDashboard(input, mockContext)

      expect(result).toContain('# Enterprise Analytics Dashboard (30d)')
      expect(result).toContain('## Organization Summary')
      expect(result).toContain('## Team Breakdown')
      expect(result).toContain('## Skill Adoption')
      expect(result).not.toContain('## Recommendation Accuracy')
    })

    it('includes recommendations when requested', async () => {
      const input = analyticsDashboardInputSchema.parse({ includeRecommendations: true })
      const result = await executeAnalyticsDashboard(input, mockContext)

      expect(result).toContain('## Recommendation Accuracy')
      expect(result).toContain('## Top Recommended Skills')
    })

    it('shows multi-team data', async () => {
      const input = analyticsDashboardInputSchema.parse({})
      const result = await executeAnalyticsDashboard(input, mockContext)

      expect(result).toContain('Engineering')
      expect(result).toContain('Data Science')
      expect(result).toContain('DevOps')
    })
  })

  describe('executeUsageReport', () => {
    it('returns summary format by default', async () => {
      const input = usageReportInputSchema.parse({})
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain('# Enterprise Usage Report (30d)')
      expect(result).toContain('## Executive Summary')
      expect(result).toContain('## Usage by Tier Feature')
      expect(result).toContain('## License Utilization')
    })

    it('returns CSV format', async () => {
      const input = usageReportInputSchema.parse({ format: 'csv' })
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain('metric,current_period,previous_period,change_percent')
      expect(result).toContain('total_calls,')
      expect(result).toContain('active_users,')
      // CSV should not contain markdown headers
      expect(result).not.toContain('#')
    })

    it('returns detailed format with per-team breakdown', async () => {
      const input = usageReportInputSchema.parse({ format: 'detailed' })
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain('## Per-Team Detailed Breakdown')
      expect(result).toContain('### Engineering')
      expect(result).toContain('### Data Science')
    })

    it('includes period comparison in summary', async () => {
      const input = usageReportInputSchema.parse({})
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain('vs previous')
      expect(result).toContain('up from')
    })
  })
})

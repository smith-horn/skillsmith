/**
 * ROI dashboard CSV export helpers — extracted from ROIDashboardService to keep
 * the main service file under the 500-line governance limit.
 */

import type { ROIDashboard } from './types.js'

/**
 * Render a partial ROI dashboard as CSV.
 * Handles user-only, stakeholder-only, or combined payloads.
 */
export function convertROIToCSV(data: Partial<ROIDashboard>): string {
  const lines: string[] = []

  if (data.user) {
    lines.push('User ROI Dashboard')
    lines.push('')
    lines.push('Metric,Value')
    lines.push(`User ID,${data.user.userId}`)
    lines.push(`Total Time Saved (min),${data.user.totalTimeSaved.toFixed(1)}`)
    lines.push(`Estimated Value (USD),${data.user.estimatedValueUsd.toFixed(2)}`)
    lines.push('')
    lines.push('Top Skills')
    lines.push('Skill ID,Skill Name,Time Saved (min)')
    for (const skill of data.user.topSkills) {
      lines.push(`${skill.skillId},${skill.skillName},${skill.timeSaved.toFixed(1)}`)
    }
  }

  if (data.stakeholder) {
    lines.push('Stakeholder ROI Dashboard')
    lines.push('')
    lines.push('Metric,Value')
    lines.push(`Total Users,${data.stakeholder.totalUsers}`)
    lines.push(`Total Activations,${data.stakeholder.totalActivations}`)
    lines.push(`Avg Time Saved Per User (min),${data.stakeholder.avgTimeSavedPerUser.toFixed(1)}`)
    lines.push(`Total Estimated Value (USD),${data.stakeholder.totalEstimatedValue.toFixed(2)}`)
    lines.push(`Adoption Rate (%),${(data.stakeholder.adoptionRate * 100).toFixed(1)}`)
    lines.push('')
    lines.push('Skill Leaderboard')
    lines.push('Skill ID,Skill Name,User Count,Total Value (USD)')
    for (const skill of data.stakeholder.skillLeaderboard) {
      lines.push(
        `${skill.skillId},${skill.skillName},${skill.userCount},${skill.totalValue.toFixed(2)}`
      )
    }
  }

  return lines.join('\n')
}

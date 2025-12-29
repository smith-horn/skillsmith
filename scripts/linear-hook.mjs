#!/usr/bin/env node
/**
 * Linear Hook - Lightweight Linear sync for git hooks
 *
 * Designed for post-commit hooks with the following constraints:
 * - Fast execution (< 2 seconds with timeout)
 * - Fails silently if LINEAR_API_KEY is not set
 * - Never blocks commits on Linear API errors
 * - Runs in background to not delay git operations
 *
 * Usage:
 *   node scripts/linear-hook.mjs post-commit   # After commit, mark issues as in-progress
 *
 * Issue: SMI-710
 */

import { execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Configuration
const LINEAR_SKILL_PATH = join(
  homedir(),
  '.claude/skills/linear/skills/linear/scripts/linear-api.mjs'
)
const ISSUE_PATTERN = /\b(SMI-\d+)\b/gi
const TIMEOUT_MS = 2000 // 2 second timeout for the entire operation

// Silent logging - only show output if DEBUG_LINEAR_HOOK is set
const DEBUG = process.env.DEBUG_LINEAR_HOOK === 'true'
function log(...args) {
  if (DEBUG) console.log('[linear-hook]', ...args)
}

/**
 * Check if Linear integration is available
 */
function isLinearAvailable() {
  if (!process.env.LINEAR_API_KEY) {
    log('LINEAR_API_KEY not set, skipping')
    return false
  }

  if (!existsSync(LINEAR_SKILL_PATH)) {
    log('Linear skill not found at:', LINEAR_SKILL_PATH)
    return false
  }

  return true
}

/**
 * Extract issue IDs from text
 */
function extractIssues(text) {
  const matches = text.match(ISSUE_PATTERN) || []
  return [...new Set(matches.map((m) => m.toUpperCase()))]
}

/**
 * Get the last commit message
 */
function getLastCommitMessage() {
  try {
    return execSync('git log -1 --format=%B', {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim()
  } catch (err) {
    log('Failed to get commit message:', err.message)
    return ''
  }
}

/**
 * Update Linear issue status with timeout
 */
async function updateIssueStatus(issueId, status) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log(`Timeout updating ${issueId}`)
      resolve(false)
    }, TIMEOUT_MS)

    try {
      const child = spawn(
        'node',
        [LINEAR_SKILL_PATH, 'update-status', '--issue', issueId, '--status', status],
        {
          env: process.env,
          stdio: DEBUG ? 'inherit' : 'ignore',
          detached: false,
        }
      )

      child.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          log(`Updated ${issueId} to ${status}`)
          resolve(true)
        } else {
          log(`Failed to update ${issueId}, exit code: ${code}`)
          resolve(false)
        }
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        log(`Error updating ${issueId}:`, err.message)
        resolve(false)
      })
    } catch (err) {
      clearTimeout(timeout)
      log(`Exception updating ${issueId}:`, err.message)
      resolve(false)
    }
  })
}

/**
 * Determine status from commit message
 * - "done", "fix", "complete", "close" -> done
 * - Default -> in_progress (issue is being worked on)
 */
function determineStatus(commitMessage) {
  const lower = commitMessage.toLowerCase()

  // Check for completion indicators
  const donePatterns = [
    /\bfix(es|ed)?\b/,
    /\bclos(e|es|ed)\b/,
    /\bcomplet(e|es|ed)\b/,
    /\bdone\b/,
    /\bfinish(es|ed)?\b/,
    /\bresolv(e|es|ed)\b/,
  ]

  for (const pattern of donePatterns) {
    if (pattern.test(lower)) {
      return 'done'
    }
  }

  // Default: mark as in progress
  return 'in_progress'
}

/**
 * Handle post-commit hook
 * Extracts issues from commit message and updates their status
 */
async function handlePostCommit() {
  if (!isLinearAvailable()) {
    process.exit(0)
  }

  const commitMessage = getLastCommitMessage()
  if (!commitMessage) {
    process.exit(0)
  }

  const issues = extractIssues(commitMessage)
  if (issues.length === 0) {
    log('No issue IDs found in commit message')
    process.exit(0)
  }

  const status = determineStatus(commitMessage)
  log(`Found issues: ${issues.join(', ')} -> ${status}`)

  // Update issues in parallel with overall timeout
  const updatePromises = issues.map((issue) => updateIssueStatus(issue, status))

  // Set overall timeout
  const overallTimeout = setTimeout(() => {
    log('Overall timeout reached, exiting')
    process.exit(0)
  }, TIMEOUT_MS + 500)

  try {
    await Promise.all(updatePromises)
    clearTimeout(overallTimeout)
  } catch (err) {
    log('Error in updates:', err.message)
  }

  process.exit(0)
}

/**
 * Main entry point
 */
async function main() {
  const [, , command] = process.argv

  // Always set a global timeout to ensure we never block
  setTimeout(() => {
    log('Global safety timeout, exiting')
    process.exit(0)
  }, TIMEOUT_MS + 1000)

  switch (command) {
    case 'post-commit':
      await handlePostCommit()
      break

    default:
      if (DEBUG) {
        console.log(`
Linear Hook - Git hook integration for Linear

Usage:
  node scripts/linear-hook.mjs post-commit

Environment:
  LINEAR_API_KEY      - Required for Linear API access
  DEBUG_LINEAR_HOOK   - Set to 'true' for verbose output

This script is designed to be called from git hooks.
It will fail silently if Linear is not configured.
`)
      }
      process.exit(0)
  }
}

main().catch((err) => {
  log('Unhandled error:', err.message)
  process.exit(0) // Always exit cleanly to not block git
})

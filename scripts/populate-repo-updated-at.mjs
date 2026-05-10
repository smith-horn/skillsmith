#!/usr/bin/env node
/**
 * SMI-4854 follow-up: one-shot bulk-populate `skills.repo_updated_at`.
 *
 * The Tier 1.5 skip-gate (PR #1064) bypasses `validateSkillMd` when
 * `repo.updatedAt` matches the prior upsert's `repo_updated_at`. The column
 * was added by SMI-4846's migration but is NULL for all 7965 existing rows
 * because no indexer run has completed under the 150s timeout to populate it
 * — catch-22.
 *
 * This script breaks the deadlock by calling GitHub /repos/{owner}/{name}
 * for every row with NULL repo_updated_at, parallelized at concurrency=20,
 * rate-limit-aware against the GitHub App's 5000/h core quota.
 *
 * Usage:
 *   varlock run -- node scripts/populate-repo-updated-at.mjs
 *   varlock run -- node scripts/populate-repo-updated-at.mjs --limit 100   # smoke test
 *   varlock run -- node scripts/populate-repo-updated-at.mjs --dry-run     # no writes
 *
 * Requires: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY,
 * SUPABASE_POOLER_URL (via pooler-psql.sh path).
 */

import { execFileSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argLimit = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 ? parseInt(args[i + 1], 10) : null
})()
const DRY_RUN = args.includes('--dry-run')
const CONCURRENCY = 20

function log(msg) {
  console.log(`[populate-repo-updated-at] ${msg}`)
}

// ─────────────── GitHub App auth ────────────────────────────────────────────

function createAppJwt(appId, privateKeyPem) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId })
  ).toString('base64url')
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  const sig = signer.sign(privateKeyPem, 'base64url')
  return `${header}.${payload}.${sig}`
}

async function getInstallationToken() {
  const appId = process.env.GITHUB_APP_ID
  const installId = process.env.GITHUB_APP_INSTALLATION_ID
  let key = process.env.GITHUB_APP_PRIVATE_KEY
  if (!appId || !installId || !key) {
    throw new Error('GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY required')
  }
  // varlock stores the key base64-encoded. Decode if it doesn't look like PEM.
  if (!key.startsWith('-----BEGIN')) {
    key = Buffer.from(key, 'base64').toString('utf8')
  }
  // Some env stores escape newlines literally.
  if (key.includes('\\n') && !key.includes('\n')) key = key.replace(/\\n/g, '\n')
  const jwt = createAppJwt(appId, key)
  const res = await fetch(`https://api.github.com/app/installations/${installId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'skillsmith-populate-repo-updated-at/1.0',
    },
  })
  if (!res.ok) {
    throw new Error(`Installation token fetch failed: ${res.status} ${await res.text()}`)
  }
  const body = await res.json()
  return body.token
}

// ─────────────── Postgres via pooler-psql.sh ────────────────────────────────

function psql(sql) {
  return execFileSync('./scripts/pooler-psql.sh', ['-A', '-t', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function loadRows() {
  const limitClause = argLimit ? `LIMIT ${argLimit}` : ''
  const sql = `SELECT repo_url FROM skills WHERE repo_url IS NOT NULL AND repo_updated_at IS NULL ${limitClause};`
  const out = psql(sql)
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith('http'))
}

function batchUpdate(pairs) {
  if (pairs.length === 0) return
  const values = pairs
    .map(([url, ts]) => `(${pgString(url)}, ${pgString(ts)}::timestamptz)`)
    .join(',')
  // Use TEXT cast for the column to avoid timestamptz formatting friction;
  // skills.repo_updated_at is TEXT per migration 20260510000001.
  const sql = `UPDATE skills SET repo_updated_at = v.ts FROM (VALUES ${values}) AS v(url, ts) WHERE skills.repo_url = v.url;`
  // pooler-psql.sh runs inside the Docker container — bind-mounted paths only.
  // Write the temp SQL under .tmp/ at the repo root so the container sees it.
  const tmpDir = join(process.cwd(), '.tmp')
  try {
    execFileSync('mkdir', ['-p', tmpDir])
  } catch {}
  const file = join(tmpDir, `populate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`)
  writeFileSync(file, sql)
  try {
    // Path relative to project root is bind-mounted into container at /app.
    execFileSync('./scripts/pooler-psql.sh', ['-A', '-f', file.replace(process.cwd() + '/', '')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } finally {
    rmSync(file, { force: true })
  }
}

function pgString(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// ─────────────── Parse + fetch ──────────────────────────────────────────────

function parseRepoUrl(url) {
  // https://github.com/{owner}/{name}
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1], name: m[2] } : null
}

async function fetchRepoUpdatedAt(token, owner, name) {
  let lastErr = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'skillsmith-populate-repo-updated-at/1.0',
        },
      })
      const remaining = res.headers.get('x-ratelimit-remaining')
      if (res.status === 404) return { gone: true, remaining }
      if (res.status === 403)
        return { rateLimited: true, remaining, reset: res.headers.get('x-ratelimit-reset') }
      if (!res.ok) return { error: `HTTP ${res.status}`, remaining }
      const body = await res.json()
      return { updatedAt: body.updated_at, remaining }
    } catch (e) {
      lastErr = e.message || 'fetch-error'
      // Transient network/DNS error — back off and retry.
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  return { error: lastErr }
}

async function mapBounded(items, mapper, concurrency) {
  const out = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await mapper(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return out
}

// ─────────────── Main ───────────────────────────────────────────────────────

;(async () => {
  log(
    `mode: ${DRY_RUN ? 'dry-run' : 'live'}, concurrency: ${CONCURRENCY}${argLimit ? `, limit: ${argLimit}` : ''}`
  )
  const token = await getInstallationToken()
  log('installation token acquired')
  const rows = loadRows()
  log(`rows to populate: ${rows.length}`)
  if (rows.length === 0) return

  let okCount = 0
  let goneCount = 0
  let errCount = 0
  const pendingUpdates = []
  const BATCH = 100
  let lastRemaining = '?'

  const start = Date.now()
  await mapBounded(
    rows,
    async (url, i) => {
      const parsed = parseRepoUrl(url)
      if (!parsed) {
        errCount++
        return
      }
      const r = await fetchRepoUpdatedAt(token, parsed.owner, parsed.name)
      if (r.remaining) lastRemaining = r.remaining
      if (r.gone) {
        goneCount++
        return
      }
      if (r.rateLimited) {
        errCount++
        // Don't abort — let other workers continue; main loop will see the
        // remaining counter drop and we'll log accordingly.
        return
      }
      if (r.error || !r.updatedAt) {
        errCount++
        return
      }
      okCount++
      pendingUpdates.push([url, r.updatedAt])
      if (pendingUpdates.length >= BATCH && !DRY_RUN) {
        const chunk = pendingUpdates.splice(0, BATCH)
        batchUpdate(chunk)
      }
      if ((i + 1) % 250 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        log(
          `progress ${i + 1}/${rows.length} | ok=${okCount} gone=${goneCount} err=${errCount} | ${elapsed}s | rate-remaining=${lastRemaining}`
        )
      }
    },
    CONCURRENCY
  )
  if (pendingUpdates.length > 0 && !DRY_RUN) {
    batchUpdate(pendingUpdates)
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  log(
    `done. ok=${okCount} gone=${goneCount} err=${errCount} | elapsed=${elapsed}s | rate-remaining=${lastRemaining}`
  )
})().catch((e) => {
  console.error('[populate-repo-updated-at] FATAL:', e.message)
  process.exit(1)
})

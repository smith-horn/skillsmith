#!/usr/bin/env tsx
/**
 * SMI-4590 Wave 4 PR 6/6 — SessionStart audit helper.
 *
 * Invoked by `scripts/session-start-audit.sh` after gate checks pass.
 * Resolves the caller's tier + audit_mode, applies a 24h debounce, and
 * runs `runInventoryAudit` for Team/Enterprise users only. Output is
 * tier-gated:
 *   - community / individual  → empty stdout (no findings rendered).
 *   - team                    → ONE-LINE collapsed summary on stderr; empty stdout.
 *   - enterprise              → ONE-LINE pointer to report path on stderr; empty stdout.
 *   - tier resolution failure → silent (community fallback). Never default-to-leak.
 *
 * Privacy boundary (LOAD-BEARING):
 *   - Per-entry detail (file paths, identifiers, embeddings) MUST NEVER
 *     reach stdout or stderr — only counts and the audit report path.
 *   - The `renderForTier` helper takes a typed `RenderInput` shape that
 *     EXCLUDES per-entry fields, so per-entry leakage is a type error.
 *   - Free/Individual paths NEVER load the audit pipeline (`runInventoryAudit`
 *     is dynamically imported AFTER the tier gate, so the 99% Free path
 *     pays nothing for the gated module).
 *
 * Why .ts (not .mjs): cross-package TypeScript imports require tsx
 * runtime resolution. Pure Node .mjs cannot import from packages/*\/src.
 * Precedent: `scripts/session-priming-query.ts` (SMI-4451 Wave 1).
 *
 * Why dynamic import for getLicenseStatus: scripts/lib/ should not
 * statically depend on `packages/cli/src/utils/license-validation.ts`
 * (direction-of-dependency violation — CLI is a leaf). Dynamic import
 * lets the helper bridge into the CLI utility without coupling the
 * scripts/ build to a CLI rebuild.
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §6.
 */

import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// 24h debounce for the per-session audit. Configurable via env for tests.
const DEFAULT_DEBOUNCE_HOURS = 24

interface ResolvedContext {
  tier: 'community' | 'individual' | 'team' | 'enterprise'
  auditMode: 'preventative' | 'power_user' | 'governance' | 'off'
  /** True when the user manually edited config to a tier-ineligible mode. */
  tierIneligibleOverride: boolean
}

/**
 * The render-input shape EXCLUDES per-entry fields by construction.
 * This is the only data type the renderer is permitted to see — so a
 * future contributor adding "let me print the colliding files inline"
 * cannot do so without changing the type signature, which gets caught
 * in code review.
 */
interface RenderInput {
  counts: { exact: number; generic: number; semantic: number }
  reportPath: string
}

interface RenderOutput {
  /** Reserved — always '' for the audit hook (priming hook owns stdout). */
  stdout: string
  /** Human-readable summary for the terminal. */
  stderr: string
}

async function main(): Promise<number> {
  const home = homedir()
  await opportunisticLogRotation(home)

  // Stage 1: resolve tier + mode. Failures fall through to a silent
  // community-equivalent return (NEVER default-to-leak).
  let ctx: ResolvedContext
  try {
    ctx = await resolveContext(home)
  } catch (err) {
    await logError(home, 'tier_resolution_failed', err)
    return 0
  }

  // Stage 2: short-circuit for any tier/mode that should not run an audit.
  // Free/Individual + community-default = silent. mode='off' = silent.
  // tierIneligibleOverride = silent (defense-in-depth).
  if (ctx.tierIneligibleOverride) {
    await logInfo(home, 'tier_disqualified', { tier: ctx.tier, auditMode: ctx.auditMode })
    return 0
  }
  if (ctx.auditMode === 'off') {
    await logInfo(home, 'user_opted_out', { tier: ctx.tier })
    return 0
  }
  if (ctx.auditMode === 'preventative') {
    await logInfo(
      home,
      ctx.tier === 'community' || ctx.tier === 'individual'
        ? 'tier_preventative'
        : 'mode_not_continuous',
      { tier: ctx.tier }
    )
    return 0
  }

  // Stage 3: 24h debounce.
  const debounceHours = readDebounceHours()
  const lastAuditPath = path.join(home, '.skillsmith', 'last-audit.json')
  if (await isDebounced(lastAuditPath, debounceHours)) {
    await logInfo(home, 'debounced', { tier: ctx.tier })
    return 0
  }

  // Stage 4: run the audit. Dynamic import — costs nothing for the
  // 99% Free/Individual path that never reaches here.
  let runInventoryAudit
  try {
    const mod = await import('@skillsmith/mcp-server/audit')
    runInventoryAudit = mod.runInventoryAudit
  } catch (err) {
    await logError(home, 'audit_module_load_failed', err)
    return 0
  }

  let auditResult
  try {
    auditResult = await runInventoryAudit({
      deep: ctx.auditMode === 'governance',
      applyExclusions: true,
      tier: ctx.tier,
      homeDir: home,
    })
  } catch (err) {
    await logError(home, 'audit_run_failed', err)
    return 0
  }

  // Stage 5: render via the typed-input gate. Per-entry fields are NOT
  // in `RenderInput`, so they cannot leak.
  const renderInput: RenderInput = {
    counts: {
      exact: auditResult.exactCollisions.length,
      generic: auditResult.genericFlags.length,
      semantic: auditResult.semanticCollisions.length,
    },
    reportPath: auditResult.reportPath,
  }
  const rendered = renderForTier(ctx.tier, renderInput)

  // stdout contract: empty (priming hook owns the additionalContext slot).
  if (rendered.stdout.length > 0) {
    process.stdout.write(rendered.stdout)
  }
  if (rendered.stderr.length > 0) {
    process.stderr.write(rendered.stderr + '\n')
  }

  // Stage 6: persist the lastAuditAt marker for the 24h debounce.
  await writeLastAudit(lastAuditPath, auditResult.auditId)

  return 0
}

// ---------------------------------------------------------------------------
// Render branch (tier → output channels)
// ---------------------------------------------------------------------------

/**
 * Single, alphabetized switch on tier. Free/Individual hard-coded to
 * empty output. Per-entry fields are NOT accepted in `RenderInput`, so
 * a future "leak the colliding paths inline" change requires editing
 * the type signature first — caught in review.
 */
function renderForTier(tier: ResolvedContext['tier'], input: RenderInput): RenderOutput {
  switch (tier) {
    case 'community':
    case 'individual':
      // Privacy boundary: NO output for free tiers.
      return { stdout: '', stderr: '' }
    case 'team':
      return {
        stdout: '',
        stderr:
          `[skillsmith] Skill audit: ` +
          `${input.counts.exact} exact, ` +
          `${input.counts.generic} generic, ` +
          `${input.counts.semantic} semantic. ` +
          `Report: ${input.reportPath}`,
      }
    case 'enterprise':
      return {
        stdout: '',
        stderr: `[skillsmith] Skill audit complete. Full report: ${input.reportPath}`,
      }
  }
}

// ---------------------------------------------------------------------------
// Tier + mode resolution
// ---------------------------------------------------------------------------

async function resolveContext(home: string): Promise<ResolvedContext> {
  const tier = await resolveTier()
  const fileMode = await readConfigAuditMode(home)
  const tierAllowsMode =
    fileMode === null ||
    tier === 'team' ||
    tier === 'enterprise' ||
    fileMode === 'preventative' ||
    fileMode === 'off'
  const tierIneligibleOverride = !tierAllowsMode
  const auditMode = tierAllowsMode && fileMode !== null ? fileMode : tierDefault(tier)
  return { tier, auditMode, tierIneligibleOverride }
}

async function resolveTier(): Promise<ResolvedContext['tier']> {
  // Try the dynamic import path first (uses the enterprise validator
  // when available). Falls back to community on any failure.
  try {
    const mod = (await import('../../packages/cli/src/utils/license-validation.js')) as {
      getLicenseStatus: () => Promise<{ tier?: string; valid?: boolean }>
    }
    const status = await mod.getLicenseStatus()
    if (
      status.tier === 'community' ||
      status.tier === 'individual' ||
      status.tier === 'team' ||
      status.tier === 'enterprise'
    ) {
      return status.tier
    }
  } catch {
    // Fall through to env-based fallback.
  }

  // Fallback: minimal env-based resolution. Decode the JWT payload's
  // `tier` claim WITHOUT signature verification — privacy boundary
  // protects against accidental output (screen-share, coworker), not
  // against self-attack. Self-claiming Enterprise unlocks
  // runInventoryAudit against the user's own machine — no data exits.
  const key = process.env['SKILLSMITH_LICENSE_KEY']
  if (!key) return 'community'
  try {
    const parts = key.split('.')
    if (parts.length < 2) return 'community'
    const payloadB64 = parts[1] ?? ''
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as {
      tier?: string
    }
    if (payload.tier === 'individual' || payload.tier === 'team' || payload.tier === 'enterprise') {
      return payload.tier
    }
  } catch {
    // Fall through to community.
  }
  return 'community'
}

function tierDefault(tier: ResolvedContext['tier']): ResolvedContext['auditMode'] {
  switch (tier) {
    case 'community':
    case 'individual':
      return 'preventative'
    case 'team':
      return 'power_user'
    case 'enterprise':
      return 'governance'
  }
}

async function readConfigAuditMode(home: string): Promise<ResolvedContext['auditMode'] | null> {
  const configPath = path.join(home, '.skillsmith', 'config.json')
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as { audit_mode?: unknown }
    const v = parsed.audit_mode
    if (v === 'preventative' || v === 'power_user' || v === 'governance' || v === 'off') {
      return v
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Debounce + last-audit marker
// ---------------------------------------------------------------------------

function readDebounceHours(): number {
  const raw = process.env['SKILLSMITH_SESSION_AUDIT_DEBOUNCE_HOURS']
  if (!raw) return DEFAULT_DEBOUNCE_HOURS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DEBOUNCE_HOURS
  return parsed
}

async function isDebounced(lastAuditPath: string, hours: number): Promise<boolean> {
  try {
    const raw = await fs.readFile(lastAuditPath, 'utf-8')
    const parsed = JSON.parse(raw) as { lastAuditAt?: string }
    if (!parsed.lastAuditAt) return false
    const lastMs = Date.parse(parsed.lastAuditAt)
    if (!Number.isFinite(lastMs)) return false
    return Date.now() - lastMs < hours * 60 * 60 * 1000
  } catch {
    return false
  }
}

async function writeLastAudit(lastAuditPath: string, auditId: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(lastAuditPath), { recursive: true, mode: 0o700 })
    const tmp = lastAuditPath + '.tmp'
    await fs.writeFile(
      tmp,
      JSON.stringify({ auditId, lastAuditAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 }
    )
    await fs.rename(tmp, lastAuditPath)
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function appendLog(
  home: string,
  level: string,
  code: string,
  payload: unknown
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const logDir = path.join(home, '.skillsmith', 'logs')
  const logPath = path.join(logDir, `session-audit-${today}.log`)
  try {
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 })
    await fs.appendFile(
      logPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        code,
        payload: serializeForLog(payload),
      }) + '\n',
      { mode: 0o600 }
    )
  } catch {
    // Best-effort.
  }
}

function serializeForLog(payload: unknown): unknown {
  if (payload instanceof Error) {
    return { name: payload.name, message: payload.message }
  }
  return payload
}

async function logInfo(home: string, code: string, payload: unknown): Promise<void> {
  await appendLog(home, 'info', code, payload)
}

async function logError(home: string, code: string, err: unknown): Promise<void> {
  await appendLog(home, 'error', code, err)
}

/**
 * Sweep `~/.skillsmith/logs/session-audit-*.log` files older than 30
 * days. Best-effort, fail-soft. Cap iteration to keep the hook bounded.
 */
async function opportunisticLogRotation(home: string): Promise<void> {
  const logDir = path.join(home, '.skillsmith', 'logs')
  try {
    const entries = await fs.readdir(logDir)
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000
    let swept = 0
    for (const entry of entries) {
      if (swept >= 64) break // Bounded iteration.
      if (!entry.startsWith('session-audit-') || !entry.endsWith('.log')) continue
      const full = path.join(logDir, entry)
      try {
        const stat = await fs.stat(full)
        if (stat.mtimeMs < cutoffMs) {
          await fs.unlink(full)
          swept++
        }
      } catch {
        // skip
      }
    }
  } catch {
    // Best-effort.
  }
}

// Suppress the "execFile imported but unused" lint hit. Reserved for
// future hook-internal subprocess gating; keep the import path warm so
// the helper file pattern matches scripts/session-priming-query.ts.
void execFileP

main()
  .then((code) => {
    process.exit(code)
  })
  .catch(() => {
    process.exit(0) // Always exit 0 — never block the hook.
  })

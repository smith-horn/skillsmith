/**
 * SMI-5213 / Wave 1 BARRIER: OpenAPI contract enforcement test.
 *
 * Guards the three-way consistency between:
 *   1. docs/internal/api/openapi.yaml  (source of truth)
 *   2. packages/core/src/api/types.ts  (API_TRUST_TIERS, API_CATEGORIES)
 *   3. supabase/config.toml            (verify_jwt = false function registrations)
 *
 * Skip-gated: the entire suite is skipped when docs/internal/api/openapi.yaml
 * is absent (external contributors / CI without the docs/internal submodule).
 *
 * verify_jwt=false (21 fns) ⊋ documented-public (12 paths).
 * The allowlist below is the positive source of truth for the public surface.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parse } from 'yaml'
import { API_TRUST_TIERS, API_CATEGORIES } from '../../src/api/types.js'

// ---------------------------------------------------------------------------
// Locate files relative to this test file
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// packages/core/tests/integration/ → up 4 dirs to repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const OPENAPI_PATH = path.join(REPO_ROOT, 'docs', 'internal', 'api', 'openapi.yaml')
const SUPABASE_CONFIG_PATH = path.join(REPO_ROOT, 'supabase', 'config.toml')
// SMI-5226: the spec is committed to the website's public/ dir so Vercel's
// remote rebuild serves it at /openapi.yaml (the deploy can't see the private
// docs/internal submodule). This committed copy must stay byte-identical to the
// source. The dedicated PR check openapi-spec-sync.yml is the enforced guard
// (the vitest CI job does not fetch docs/internal); this is local-dev signal.
const WEBSITE_SPEC_PATH = path.join(REPO_ROOT, 'packages', 'website', 'public', 'openapi.yaml')

// ---------------------------------------------------------------------------
// Allowlist of the 12 documented public endpoints (positive source of truth)
// ---------------------------------------------------------------------------

const DOCUMENTED_ENDPOINTS = [
  '/skills-search',
  '/skills-get',
  '/skills-recommend',
  '/events',
  '/health',
  '/stats',
  '/early-access-signup',
  '/contact-submit',
  '/checkout',
  '/stripe-webhook',
  '/auth-device-code',
  '/auth-device-token',
] as const

// Gateway-verified functions (deploy WITHOUT --no-verify-jwt); they appear in
// config.toml with verify_jwt = true and are NOT in the allowlist above but
// may be reachable via other surfaces.
const GATEWAY_VERIFIED_EXCEPTIONS = new Set([
  'webhook-dlq',
  'auth-device-approve',
  'auth-device-preview',
  'indexer-dispatch',
  'team-invite-send',
  'sync-stripe-email',
  'sync-oauth-email',
])

// ---------------------------------------------------------------------------
// Recursive walker: collect every { fieldName, enum } pair in any YAML object
// Handles both parameter-style (object has `name` + `schema.enum`) and
// schema-property style (object has property key == fieldName with `.enum`).
// ---------------------------------------------------------------------------

type YamlNode = Record<string, unknown> | unknown[] | unknown

interface EnumOccurrence {
  fieldName: string
  enumValues: string[]
  /** Human-readable breadcrumb for assertion messages */
  location: string
}

function collectEnums(node: YamlNode, breadcrumb: string): EnumOccurrence[] {
  if (!node || typeof node !== 'object') return []

  const results: EnumOccurrence[] = []

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      results.push(...collectEnums(node[i] as YamlNode, `${breadcrumb}[${i}]`))
    }
    return results
  }

  const obj = node as Record<string, unknown>

  // Parameter-style: { name: 'trust_tier', schema: { enum: [...] } }
  if (
    typeof obj['name'] === 'string' &&
    obj['schema'] &&
    typeof obj['schema'] === 'object' &&
    !Array.isArray(obj['schema'])
  ) {
    const schema = obj['schema'] as Record<string, unknown>
    if (Array.isArray(schema['enum'])) {
      results.push({
        fieldName: obj['name'] as string,
        enumValues: schema['enum'] as string[],
        location: `${breadcrumb}(param:${obj['name']}).schema.enum`,
      })
    }
  }

  // Schema-property style: { properties: { trust_tier: { enum: [...] } } }
  if (
    obj['properties'] &&
    typeof obj['properties'] === 'object' &&
    !Array.isArray(obj['properties'])
  ) {
    const props = obj['properties'] as Record<string, unknown>
    for (const [propName, propVal] of Object.entries(props)) {
      if (
        propVal &&
        typeof propVal === 'object' &&
        !Array.isArray(propVal) &&
        Array.isArray((propVal as Record<string, unknown>)['enum'])
      ) {
        results.push({
          fieldName: propName,
          enumValues: (propVal as Record<string, unknown>)['enum'] as string[],
          location: `${breadcrumb}.properties.${propName}.enum`,
        })
      }
      // Recurse into the property value
      results.push(...collectEnums(propVal as YamlNode, `${breadcrumb}.properties.${propName}`))
    }
  }

  // Recurse into all other keys (skipping 'properties' already handled and 'schema'
  // only if we didn't already collect from it above — but recurse always to find nested)
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'properties') continue // already handled above
    results.push(...collectEnums(val as YamlNode, `${breadcrumb}.${key}`))
  }

  return results
}

// ---------------------------------------------------------------------------
// Deduplicate by (fieldName, location) to avoid double-counting from recursion
// ---------------------------------------------------------------------------

function deduplicateEnums(occurrences: EnumOccurrence[]): EnumOccurrence[] {
  const seen = new Set<string>()
  return occurrences.filter((o) => {
    const key = `${o.fieldName}::${o.location}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// Parse config.toml: collect function names with verify_jwt = false
// ---------------------------------------------------------------------------

function collectNoJwtFunctions(tomlContent: string): Set<string> {
  const result = new Set<string>()
  // Match [functions.<name>] blocks followed by verify_jwt = false
  const blockRegex = /\[functions\.([^\]]+)\][^[]*verify_jwt\s*=\s*false/g
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(tomlContent)) !== null) {
    result.add(match[1].trim())
  }
  return result
}

// ---------------------------------------------------------------------------
// Conditionally skip when submodule is absent
// ---------------------------------------------------------------------------

const specExists = existsSync(OPENAPI_PATH)

describe.skipIf(!specExists)('SMI-5213: OpenAPI contract', () => {
  // Parse once per suite
  const specContent = specExists ? readFileSync(OPENAPI_PATH, 'utf-8') : ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec = specExists ? (parse(specContent) as any) : null

  // -------------------------------------------------------------------------
  // Top-level metadata assertions
  // -------------------------------------------------------------------------

  it('license is Elastic License 2.0', () => {
    expect(spec.info.license.name).toBe('Elastic License 2.0')
  })

  it('production server URL is https://api.skillsmith.app', () => {
    const servers: Array<{ url: string; description?: string }> = spec.servers ?? []
    const prodServer = servers.find((s) => s.description?.toLowerCase().includes('production'))
    expect(prodServer, 'No production server entry found').toBeDefined()
    expect(prodServer!.url).toBe('https://api.skillsmith.app')
  })

  it('contact.url includes smith-horn', () => {
    expect(spec.info.contact.url).toContain('smith-horn')
  })

  // -------------------------------------------------------------------------
  // Enum consistency: trust_tier
  // -------------------------------------------------------------------------

  it('all trust_tier enum occurrences match API_TRUST_TIERS', () => {
    const all = deduplicateEnums(collectEnums(spec, 'spec'))
    const trustTierOccurrences = all.filter((o) => o.fieldName === 'trust_tier')

    expect(
      trustTierOccurrences.length,
      `Expected ≥2 trust_tier enum occurrences, found ${trustTierOccurrences.length}: ${trustTierOccurrences.map((o) => o.location).join(', ')}`
    ).toBeGreaterThanOrEqual(2)

    for (const occurrence of trustTierOccurrences) {
      expect(occurrence.enumValues, `trust_tier enum mismatch at ${occurrence.location}`).toEqual([
        ...API_TRUST_TIERS,
      ])
    }
  })

  it('all category enum occurrences match API_CATEGORIES', () => {
    const all = deduplicateEnums(collectEnums(spec, 'spec'))
    const categoryOccurrences = all.filter((o) => o.fieldName === 'category')

    expect(
      categoryOccurrences.length,
      `Expected ≥1 category enum occurrence, found ${categoryOccurrences.length}: ${categoryOccurrences.map((o) => o.location).join(', ')}`
    ).toBeGreaterThanOrEqual(1)

    for (const occurrence of categoryOccurrences) {
      expect(occurrence.enumValues, `category enum mismatch at ${occurrence.location}`).toEqual([
        ...API_CATEGORIES,
      ])
    }
  })

  // -------------------------------------------------------------------------
  // Documented paths
  // -------------------------------------------------------------------------

  it('spec documents all 12 allowlisted paths', () => {
    const specPaths: string[] = Object.keys(spec.paths ?? {})
    for (const endpoint of DOCUMENTED_ENDPOINTS) {
      expect(specPaths, `Spec is missing documented endpoint: ${endpoint}`).toContain(endpoint)
    }
  })

  it('spec contains no undocumented paths beyond the allowlist', () => {
    const specPaths: string[] = Object.keys(spec.paths ?? {})
    const allowSet = new Set<string>(DOCUMENTED_ENDPOINTS)
    const extras = specPaths.filter((p) => !allowSet.has(p))
    expect(
      extras,
      `Spec contains paths not in the documented allowlist: ${extras.join(', ')}`
    ).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // config.toml surface alignment
  // -------------------------------------------------------------------------

  it("each documented endpoint's function name is registered as verify_jwt=false (or is a gateway-verified exception)", () => {
    expect(existsSync(SUPABASE_CONFIG_PATH), 'supabase/config.toml not found').toBe(true)
    const toml = readFileSync(SUPABASE_CONFIG_PATH, 'utf-8')
    const noJwtFunctions = collectNoJwtFunctions(toml)

    for (const endpoint of DOCUMENTED_ENDPOINTS) {
      // Strip leading slash to get function name
      const fnName = endpoint.replace(/^\//, '')
      const isNoJwt = noJwtFunctions.has(fnName)
      const isException = GATEWAY_VERIFIED_EXCEPTIONS.has(fnName)
      expect(
        isNoJwt || isException,
        `${endpoint} (fn: ${fnName}) is neither in verify_jwt=false list nor in GATEWAY_VERIFIED_EXCEPTIONS`
      ).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // SMI-5226: committed website copy must match the source byte-for-byte
  // -------------------------------------------------------------------------

  it('committed packages/website/public/openapi.yaml is byte-identical to the source', () => {
    expect(
      existsSync(WEBSITE_SPEC_PATH),
      'packages/website/public/openapi.yaml is missing — run `npm run sync:openapi` in packages/website and commit'
    ).toBe(true)
    const websiteCopy = readFileSync(WEBSITE_SPEC_PATH, 'utf-8')
    expect(
      websiteCopy,
      'public/openapi.yaml drifted from docs/internal/api/openapi.yaml — run `npm run sync:openapi` in packages/website and commit'
    ).toBe(specContent)
  })
})

/**
 * SMI-6680 (PR #2860 gate finding 1): `REGISTRY_RESULTS` in `team-activity-format.ts`
 * used to carry a comment claiming that widening either real registry-result writer
 * union "fails typecheck until the map below gains a matching entry". That was false:
 * `REGISTRY_RESULTS` is an independent website-local `as const` tuple that nothing in
 * `packages/website` imports it into or out of, so TypeScript has no way to relate it
 * to the writer unions. Widening a writer changed nothing about
 * `(typeof REGISTRY_RESULTS)[number]` — only widening `REGISTRY_RESULTS` itself could
 * ever break `ATTEMPT_OUTCOMES`, which is the tautology of a type breaking a map
 * derived from that same type.
 *
 * This test is the real mechanism the comment now points to. It reads three files'
 * *source text* at runtime (not their compiled types, and not by importing them) and
 * asserts the union of the two real writer result-literal sets equals
 * `REGISTRY_RESULTS`'s own set, exactly:
 *   - `RegistryReadAuditEvent['result']` + `RegistryMutationAuditEvent['result']` in
 *     `packages/mcp-server/src/tools/registry-tools.live.audit.ts`
 *   - `AuditResult` in `supabase/functions/private-registry-get/access.ts`
 *
 * Why source text, not a typecheck assertion: the root `tsconfig.json` references only
 * `core`/`mcp-server`/`cli`/`enterprise` (SMI-6300) — `packages/website` isn't in it, so
 * a type-level constraint here is invisible to `npm run typecheck` and only surfaces
 * under `astro check`, a different (and less commonly run) gate.
 *
 * Why source text, not an import: `access.ts` is a Deno edge function and
 * `packages/mcp-server` is a separate workspace package — neither imports cleanly into
 * a Vitest/Node run of `packages/website`. Reading the literal source text works across
 * both the runtime boundary (Deno vs Node) and the package boundary.
 *
 * `supabase/functions/**` is git-crypt encrypted; a fork PR without
 * `secrets.GIT_CRYPT_KEY` sees ciphertext for `access.ts` — this test detects the
 * `\x00GITCRYPT` header (same sentinel pattern as `vitest.config.ts`'s
 * `gitCryptLocked()`) and skips cleanly rather than false-failing on an environment
 * that was never going to have the plaintext.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { REGISTRY_RESULTS } from './team-activity-format'

const here = dirname(fileURLToPath(import.meta.url))
// packages/website/src/lib -> repo root
const repoRoot = resolve(here, '../../../..')

const MCP_WRITER_PATH = resolve(
  repoRoot,
  'packages/mcp-server/src/tools/registry-tools.live.audit.ts'
)
const ACCESS_PATH = resolve(repoRoot, 'supabase/functions/private-registry-get/access.ts')

/** Every quoted string literal found in `s` (single- or double-quoted). */
function extractQuotedLiterals(s: string): string[] {
  const out: string[] = []
  const re = /'([^']+)'|"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2])
  return out
}

/** Sorted, de-duplicated array — for order/duplicate-insensitive set comparison. */
function sortedSet(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function isGitCryptLocked(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const head = readFileSync(path).subarray(0, 9).toString('binary')
    return head.startsWith('\x00GITCRYPT')
  } catch {
    return false
  }
}

describe('REGISTRY_RESULTS stays in sync with the real registry-result writers (SMI-6680)', () => {
  it('equals the union of RegistryReadAuditEvent/RegistryMutationAuditEvent result literals and AuditResult', () => {
    expect(existsSync(MCP_WRITER_PATH)).toBe(true)
    const mcpSource = readFileSync(MCP_WRITER_PATH, 'utf8')

    const readBlock =
      /export type RegistryReadAuditEvent = RegistryAuditEventFields & \{([\s\S]*?)\n\}/.exec(
        mcpSource
      )
    const mutationBlock =
      /export type RegistryMutationAuditEvent = RegistryAuditEventFields & \{([\s\S]*?)\n\}/.exec(
        mcpSource
      )
    // A failed extraction (renamed type, reshaped declaration) must fail loudly, not
    // silently compare against an empty set and pass — that would be the exact
    // "check scoped narrower than the claim drawn from it" defect this test exists to
    // avoid.
    expect(
      readBlock,
      'RegistryReadAuditEvent block not found — source shape changed'
    ).not.toBeNull()
    expect(
      mutationBlock,
      'RegistryMutationAuditEvent block not found — source shape changed'
    ).not.toBeNull()

    const readResultLine = /result:\s*([^\n]+)/.exec(readBlock![1])
    const mutationResultLine = /result:\s*([^\n]+)/.exec(mutationBlock![1])
    expect(readResultLine, "RegistryReadAuditEvent has no 'result:' field").not.toBeNull()
    expect(mutationResultLine, "RegistryMutationAuditEvent has no 'result:' field").not.toBeNull()

    const readLiterals = extractQuotedLiterals(readResultLine![1])
    const mutationLiterals = extractQuotedLiterals(mutationResultLine![1])
    expect(readLiterals.length).toBeGreaterThan(0)
    expect(mutationLiterals.length).toBeGreaterThan(0)

    if (isGitCryptLocked(ACCESS_PATH)) {
      // Fork PR without secrets.GIT_CRYPT_KEY — access.ts is unreadable ciphertext in
      // this environment. Nothing to compare; skip rather than false-fail. CI's own
      // "Test (website)" job unlocks git-crypt before this suite runs (ci.yml:1238-1246),
      // so this only trips for forks/local-locked checkouts, never the merge-gating run.
      return
    }

    expect(existsSync(ACCESS_PATH)).toBe(true)
    const accessSource = readFileSync(ACCESS_PATH, 'utf8')
    const accessMatch = /export type AuditResult\s*=\s*([^\n]+)/.exec(accessSource)
    expect(accessMatch, 'AuditResult declaration not found — source shape changed').not.toBeNull()
    const accessLiterals = extractQuotedLiterals(accessMatch![1])
    expect(accessLiterals.length).toBeGreaterThan(0)

    const writerUnion = sortedSet([...readLiterals, ...mutationLiterals, ...accessLiterals])
    const websiteSet = sortedSet([...REGISTRY_RESULTS])

    expect(websiteSet).toEqual(writerUnion)
  })
})

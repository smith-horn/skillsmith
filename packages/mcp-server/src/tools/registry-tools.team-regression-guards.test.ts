/**
 * @fileoverview SMI-6622 item 9 — regression guards for code this issue does NOT change
 * @see SMI-6622: `registry-tools.ts` stopped gating its own service selection / team resolution on
 *      Supabase env vars. This file proves that move was scoped correctly: `team-resolver.ts`'s
 *      shared `resolveLicenseTeamId()` (still used directly by other tool families — SMI-6623) and
 *      the sibling `team-workspace`/`rbac-tools`/`sso-tools` families' own service selection are
 *      untouched.
 *
 * Deliberately standalone — no import of `registry-tools.team.ts` anywhere in this file (not even
 * transitively through `registry-tools.js`), so these two guards keep passing even when that
 * module is reverted/deleted (the SMI-6598 revert-check `registry-tools.team.test.ts`'s own
 * new-behavior tests are held to). A shared file would fail this file's OWN load under that
 * revert, for a reason unrelated to what these two tests actually assert.
 */

import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../context.js'

function makeContext(): ToolContext {
  return {} as unknown as ToolContext
}

describe('SMI-6622 item 9 — regression guards (unaffected code)', () => {
  it('team-resolver.ts resolveLicenseTeamId() still returns null with no credential/env (SMI-6623)', async () => {
    const origUrl = process.env.SUPABASE_URL
    const origAnon = process.env.SUPABASE_ANON_KEY
    const origLicense = process.env.SKILLSMITH_LICENSE_KEY
    const origApiKey = process.env.SKILLSMITH_API_KEY
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY
    delete process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_API_KEY
    try {
      vi.resetModules()
      const { resolveLicenseTeamId } = await import('./team-resolver.js')
      await expect(resolveLicenseTeamId()).resolves.toBeNull()
    } finally {
      if (origUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = origUrl
      if (origAnon === undefined) delete process.env.SUPABASE_ANON_KEY
      else process.env.SUPABASE_ANON_KEY = origAnon
      if (origLicense === undefined) delete process.env.SKILLSMITH_LICENSE_KEY
      else process.env.SKILLSMITH_LICENSE_KEY = origLicense
      if (origApiKey === undefined) delete process.env.SKILLSMITH_API_KEY
      else process.env.SKILLSMITH_API_KEY = origApiKey
    }
  })

  it('team-workspace/rbac/sso service selection is unchanged with no Supabase env', async () => {
    const origUrl = process.env.SUPABASE_URL
    const origAnon = process.env.SUPABASE_ANON_KEY
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY
    try {
      vi.resetModules()
      const [{ executeTeamWorkspace }, { executeRbacManage }, { executeSsoSettings }] =
        await Promise.all([
          import('./team-workspace.js'),
          import('./rbac-tools.action.js'),
          import('./sso-tools.action.js'),
        ])

      const wsResult = await executeTeamWorkspace({ action: 'list' }, makeContext())
      expect(wsResult.dataSource).toBe('stub')

      const rbacResult = await executeRbacManage({ action: 'list_roles' }, makeContext())
      expect(rbacResult.dataSource).toBe('stub')

      const ssoResult = await executeSsoSettings({ includeMetadata: false }, makeContext())
      expect(ssoResult.dataSource).toBe('stub')
    } finally {
      if (origUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = origUrl
      if (origAnon === undefined) delete process.env.SUPABASE_ANON_KEY
      else process.env.SUPABASE_ANON_KEY = origAnon
    }
  })
})

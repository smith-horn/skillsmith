/**
 * Tests for SMI-4456 / SMI-4457 / SMI-4458 audit-standards backstops.
 *
 * R-1: extractCliCommandNames + findCliHintCommandRefs (SMI-4456)
 * R-2: findRelativeFunctionsV1Urls (SMI-4457)
 * R-3: findReturningTableAmbiguity (SMI-4458)
 *
 * Lives in its own file (not audit-standards.test.ts) to keep both files
 * under the 500-line pre-commit gate. Same dynamic-ESM-import convention
 * as the original.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  extractCliCommandNames: (indexSrc: string, commandSources: Record<string, string>) => Set<string>
  findCliHintCommandRefs: (cliSrcByPath: Record<string, string>) => Array<{
    file: string
    line: number
    refToken: string
    fullMatch: string
  }>
  findRelativeFunctionsV1Urls: (websiteSrcByPath: Record<string, string>) => Array<{
    file: string
    line: number
    snippet: string
  }>
  findReturningTableAmbiguity: (migrationsByPath: Record<string, string>) => Array<{
    file: string
    line: number
    fnName: string
    col: string
    snippet: string
  }>
}

const {
  extractCliCommandNames,
  findCliHintCommandRefs,
  findRelativeFunctionsV1Urls,
  findReturningTableAmbiguity,
} = helpers

describe('extractCliCommandNames (R-1, SMI-4456)', () => {
  it('extracts program.command(...) registrations from index', () => {
    const indexSrc = `
      program.command('import').description('foo')
      program.addCommand(createSearchCommand())
    `
    const commandSources = {
      '/cli/src/commands/search.ts': `export function createSearchCommand() { return new Command('search') }`,
    }
    const names = extractCliCommandNames(indexSrc, commandSources)
    expect(names.has('import')).toBe(true)
    expect(names.has('search')).toBe(true)
  })

  it('captures .name() overrides applied at addCommand time', () => {
    const indexSrc = `
      program.addCommand(createInitCommand().name('init'))
      program.addCommand(createValidateCommand().name('validate'))
    `
    const names = extractCliCommandNames(indexSrc, {})
    expect(names.has('init')).toBe(true)
    expect(names.has('validate')).toBe(true)
  })

  it('captures .alias(...) declarations in command factories', () => {
    const commandSources = {
      '/cli/src/commands/manage.ts': `
        return new Command('list').alias('ls')
        return new Command('remove').alias('rm').alias('uninstall')
      `,
    }
    const names = extractCliCommandNames('', commandSources)
    expect(names.has('list')).toBe(true)
    expect(names.has('ls')).toBe(true)
    expect(names.has('rm')).toBe(true)
    expect(names.has('uninstall')).toBe(true)
  })

  it('ignores command names that appear inside comments', () => {
    const commandSources = {
      '/cli/src/commands/foo.ts': `
        // new Command('skills') — comment-cited name should NOT register
        return new Command('foo')
      `,
    }
    const names = extractCliCommandNames('', commandSources)
    expect(names.has('foo')).toBe(true)
    expect(names.has('skills')).toBe(false)
  })
})

describe('findCliHintCommandRefs (R-1, SMI-4456)', () => {
  it('detects "Try it: skillsmith <subcmd>" hints', () => {
    const cliSrcByPath = {
      '/cli/src/commands/login.ts': `
        console.log(chalk.green('Logged in successfully.'))
        console.log(chalk.dim('  Try it: skillsmith search mcp'))
        process.exit(0)
      `,
    }
    const refs = findCliHintCommandRefs(cliSrcByPath)
    expect(refs).toHaveLength(1)
    expect(refs[0].refToken).toBe('search')
    expect(refs[0].file).toBe('/cli/src/commands/login.ts')
  })

  it('detects all four hint markers across skillsmith and sklx', () => {
    const cliSrcByPath = {
      '/cli/src/foo.ts': `
        // Try it: skillsmith should-be-skipped — comment line
        log('Run: skillsmith install foo')
        log('Visit: sklx info bar')
        log('Use: skillsmith pin bar')
        log('Try it: sklx search baz')
      `,
    }
    const refs = findCliHintCommandRefs(cliSrcByPath)
    const tokens = refs.map((r) => r.refToken).sort()
    expect(tokens).toEqual(['info', 'install', 'pin', 'search'])
  })

  it('SMI-4454 B3 regression case: "skills list" not in registered set', () => {
    const cliSrcByPath = {
      '/cli/src/commands/login.ts': `console.log('  Try it: skillsmith skills list')`,
    }
    const registered = new Set(['login', 'search', 'list', 'logout'])
    const refs = findCliHintCommandRefs(cliSrcByPath)
    const violations = refs.filter((r) => !registered.has(r.refToken))
    expect(violations).toHaveLength(1)
    expect(violations[0].refToken).toBe('skills')
  })

  it('SMI-4454 B3 fix passes: "search mcp" is registered', () => {
    const cliSrcByPath = {
      '/cli/src/commands/login.ts': `console.log('  Try it: skillsmith search mcp')`,
    }
    const registered = new Set(['login', 'search', 'list', 'logout'])
    const refs = findCliHintCommandRefs(cliSrcByPath)
    const violations = refs.filter((r) => !registered.has(r.refToken))
    expect(violations).toHaveLength(0)
  })
})

describe('findRelativeFunctionsV1Urls (R-2, SMI-4457)', () => {
  it('flags relative /functions/v1/ string literals', () => {
    const websiteSrcByPath = {
      '/website/src/pages/device.astro': `
        const PREVIEW_URL = '/functions/v1/auth-device-preview'
        const APPROVE_URL = "/functions/v1/auth-device-approve"
      `,
    }
    const violations = findRelativeFunctionsV1Urls(websiteSrcByPath)
    expect(violations).toHaveLength(2)
    expect(violations[0].file).toBe('/website/src/pages/device.astro')
  })

  it('passes the canonical absolute pattern (PR #757 fix)', () => {
    const websiteSrcByPath = {
      '/website/src/pages/device.astro': `
        const API_BASE = import.meta.env.PUBLIC_API_BASE_URL || 'https://api.skillsmith.app'
        const PREVIEW_URL = \`\${API_BASE}/functions/v1/auth-device-preview\`
      `,
    }
    const violations = findRelativeFunctionsV1Urls(websiteSrcByPath)
    expect(violations).toHaveLength(0)
  })

  it('skips comment lines that mention /functions/v1/', () => {
    const websiteSrcByPath = {
      '/website/src/foo.ts': `
        // The endpoint at '/functions/v1/foo' is the legacy form — DO NOT use
        const URL = \`\${API_BASE}/functions/v1/foo\`
      `,
    }
    const violations = findRelativeFunctionsV1Urls(websiteSrcByPath)
    expect(violations).toHaveLength(0)
  })

  it('reports file:line for every violation', () => {
    const websiteSrcByPath = {
      '/website/src/a.ts': `
        const x = 1
        const y = '/functions/v1/foo'
        const z = 3
      `,
    }
    const violations = findRelativeFunctionsV1Urls(websiteSrcByPath)
    expect(violations).toHaveLength(1)
    expect(violations[0].line).toBe(3)
  })
})

describe('findReturningTableAmbiguity (R-3, SMI-4458)', () => {
  it('flags unqualified RETURNING <col> matching a TABLE OUT name', () => {
    const migration = `
      CREATE OR REPLACE FUNCTION public.foo(p TEXT)
      RETURNS TABLE (status TEXT, user_id UUID)
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_claimed UUID;
      BEGIN
        UPDATE public.t
           SET consumed_at = NOW()
         WHERE x = p
        RETURNING user_id INTO v_claimed;
      END;
      $$;
    `
    const violations = findReturningTableAmbiguity({ '081_foo.sql': migration })
    expect(violations).toHaveLength(1)
    expect(violations[0].fnName).toBe('public.foo')
    expect(violations[0].col).toBe('user_id')
  })

  it('passes when RETURNING column is qualified with table alias', () => {
    const migration = `
      CREATE OR REPLACE FUNCTION public.foo(p TEXT)
      RETURNS TABLE (status TEXT, user_id UUID)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        UPDATE public.t AS dc
           SET consumed_at = NOW()
         WHERE dc.x = p
        RETURNING dc.user_id INTO v_claimed;
      END;
      $$;
    `
    const violations = findReturningTableAmbiguity({ '081_foo.sql': migration })
    expect(violations).toHaveLength(0)
  })

  it('lets a later migration supersede an earlier broken definition (SMI-4454 B2 fix)', () => {
    const broken = `
      CREATE OR REPLACE FUNCTION public.claim(p TEXT)
      RETURNS TABLE (status TEXT, user_id UUID)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        UPDATE public.t SET y = NOW() WHERE x = p
        RETURNING user_id INTO v_claimed;
      END;
      $$;
    `
    const fixed = `
      CREATE OR REPLACE FUNCTION public.claim(p TEXT)
      RETURNS TABLE (status TEXT, user_id UUID)
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        UPDATE public.t dc SET y = NOW() WHERE dc.x = p
        RETURNING dc.user_id INTO v_claimed;
      END;
      $function$;
    `
    expect(
      findReturningTableAmbiguity({ '081_first.sql': broken, '083_fix.sql': fixed })
    ).toHaveLength(0)
  })

  it('flags when later migration does NOT supersede the broken function', () => {
    const broken = `
      CREATE OR REPLACE FUNCTION public.foo(p TEXT)
      RETURNS TABLE (status TEXT, user_id UUID)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        UPDATE public.t SET y = NOW() WHERE x = p
        RETURNING user_id INTO v_claimed;
      END;
      $$;
    `
    const unrelated = `CREATE INDEX idx_foo ON public.t (x);`
    const violations = findReturningTableAmbiguity({
      '081_broken.sql': broken,
      '084_other.sql': unrelated,
    })
    expect(violations).toHaveLength(1)
    expect(violations[0].fnName).toBe('public.foo')
  })

  it('handles $function$ dollar-quoting tag (matches migration 083)', () => {
    const migration = `
      CREATE OR REPLACE FUNCTION public.foo(p TEXT)
      RETURNS TABLE (status TEXT, user_id UUID)
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        UPDATE public.t SET y = NOW() WHERE x = p
        RETURNING user_id INTO v_claimed;
      END;
      $function$;
    `
    const violations = findReturningTableAmbiguity({ '083_foo.sql': migration })
    expect(violations).toHaveLength(1)
    expect(violations[0].col).toBe('user_id')
  })

  it('correctly attributes violations across adjacent functions (parser regression)', () => {
    const migration = `
      CREATE OR REPLACE FUNCTION public.approve(p TEXT)
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN '{}'::jsonb;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.claim(p TEXT)
      RETURNS TABLE (status TEXT, user_id UUID)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        UPDATE public.t SET y = NOW() WHERE x = p
        RETURNING user_id INTO v_claimed;
      END;
      $$;
    `
    const violations = findReturningTableAmbiguity({ '081_two_fns.sql': migration })
    expect(violations).toHaveLength(1)
    expect(violations[0].fnName).toBe('public.claim')
  })

  it('skips RETURNING in SQL line comments', () => {
    const migration = `
      CREATE OR REPLACE FUNCTION public.foo(p TEXT)
      RETURNS TABLE (status TEXT, user_id UUID)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        -- RETURNING user_id INTO x  -- comment, not real code
        UPDATE public.t SET y = NOW() WHERE x = p
        RETURNING dc.user_id INTO v_claimed;
      END;
      $$;
    `
    const violations = findReturningTableAmbiguity({ '081_foo.sql': migration })
    expect(violations).toHaveLength(0)
  })
})

/**
 * SMI-6457: static guard flagging host-side fs ops against a docker-compose.yml
 * named-volume path. Fixture cases use the EXACT pre-fix source shapes from
 * SMI-6453 (not substituted-literal stand-ins) per the plan's Wave 1 Step 3.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import {
  parseNamedVolumeRepoRelativePaths,
  findHostSideNamedVolumeOps,
  allowlistKeyFor,
} from '../audit-host-volume-fs-guard-helpers.mjs'

const FIXTURE_COMPOSE_YAML = `
services:
  dev:
    volumes:
      - .:/app
      - node_modules:/app/node_modules
      - mcp-server-node-modules:/app/packages/mcp-server/node_modules
      - doc-retrieval-mcp-node-modules:/app/packages/doc-retrieval-mcp/node_modules
      - website-vercel-output:/app/packages/website/.vercel
      - \${HOST_CACHE_DIR}:/app/some-cache
volumes:
  node_modules:
  mcp-server-node-modules:
  doc-retrieval-mcp-node-modules:
  website-vercel-output:
`

describe('parseNamedVolumeRepoRelativePaths', () => {
  it('collects repo-relative paths for named-volume mounts only', () => {
    const paths = parseNamedVolumeRepoRelativePaths(FIXTURE_COMPOSE_YAML)
    expect(paths).toContain('node_modules')
    expect(paths).toContain('packages/mcp-server/node_modules')
    expect(paths).toContain('packages/doc-retrieval-mcp/node_modules')
    expect(paths).toContain('packages/website/.vercel')
  })

  it('excludes the bind-mount root (.:/app)', () => {
    const paths = parseNamedVolumeRepoRelativePaths(FIXTURE_COMPOSE_YAML)
    expect(paths).not.toContain('')
  })

  it('excludes an interpolated ${VAR} source (unknown, not assumed-bind)', () => {
    const paths = parseNamedVolumeRepoRelativePaths(FIXTURE_COMPOSE_YAML)
    expect(paths).not.toContain('some-cache')
  })
})

describe('findHostSideNamedVolumeOps', () => {
  const roots: string[] = []
  const namedVolumePaths = [
    'node_modules',
    'packages/mcp-server/node_modules',
    'packages/doc-retrieval-mcp/node_modules',
  ]

  function makeFile(content: string): string {
    const root = mkdtempSync(join(tmpdir(), 'smi6457-'))
    roots.push(root)
    const file = join(root, 'launcher.sh')
    writeFileSync(file, content, 'utf8')
    return file
  }

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
  })

  it('fires on the NM_SENTINEL shape (cross-line variable resolution)', () => {
    const file = makeFile(
      [
        '#!/usr/bin/env bash',
        'NM_SENTINEL="$REPO_ROOT/node_modules/.package-lock.json"',
        'if [ ! -f "$NM_SENTINEL" ]; then',
        '  echo missing',
        'fi',
      ].join('\n')
    )
    const findings = findHostSideNamedVolumeOps([file], namedVolumePaths)
    expect(findings).toHaveLength(1)
    expect(findings[0].matchedPath).toBe('node_modules')
    expect(findings[0].operation).toBe('[ ! -f')
  })

  it('fires on the ${REPO_ROOT} (braced) variant', () => {
    const file = makeFile(
      ['NM_SENTINEL="${REPO_ROOT}/node_modules/.package-lock.json"', 'test -f "$NM_SENTINEL"'].join(
        '\n'
      )
    )
    const findings = findHostSideNamedVolumeOps([file], namedVolumePaths)
    expect(findings).toHaveLength(1)
    expect(findings[0].matchedPath).toBe('node_modules')
  })

  it('fires on the nested-corrupt rm -rf shape via static-prefix matching (dynamic $dep_name tail)', () => {
    const file = makeFile('rm -rf packages/doc-retrieval-mcp/node_modules/$dep_name')
    const findings = findHostSideNamedVolumeOps([file], namedVolumePaths)
    expect(findings).toHaveLength(1)
    expect(findings[0].matchedPath).toBe('packages/doc-retrieval-mcp/node_modules')
    expect(findings[0].operation).toBe('rm -rf')
  })

  it('does NOT fire when the same nested-corrupt line is docker-exec-wrapped', () => {
    const file = makeFile(
      `docker exec "$CONTAINER" sh -c 'rm -rf packages/doc-retrieval-mcp/node_modules/$dep_name'`
    )
    const findings = findHostSideNamedVolumeOps([file], namedVolumePaths)
    expect(findings).toHaveLength(0)
  })

  it('does NOT fire on a target with no resolvable static prefix at all', () => {
    const file = makeFile('existsSync(dynamicPathFromElsewhere)')
    const findings = findHostSideNamedVolumeOps([file], namedVolumePaths)
    expect(findings).toHaveLength(0)
  })

  it('does NOT fire on a path outside any named volume', () => {
    const file = makeFile('if [ -f "packages/mcp-server/dist/src/index.js" ]; then true; fi')
    const findings = findHostSideNamedVolumeOps([file], namedVolumePaths)
    expect(findings).toHaveLength(0)
  })

  it('resolves a JS existsSync(join(...)) call with a literal-prefix + dynamic-tail argument', () => {
    const file = makeFile(
      [
        'const pkgDir = join(process.env.SKILLSMITH_LAUNCHER_REPO_ROOT, "packages", "mcp-server");',
        'existsSync(join(pkgDir, "node_modules", name))',
      ].join('\n')
    )
    const findings = findHostSideNamedVolumeOps([file], namedVolumePaths)
    expect(findings).toHaveLength(1)
    expect(findings[0].matchedPath).toBe('packages/mcp-server/node_modules')
  })

  it('allowlistKeyFor is a stable content fingerprint, not line-number-keyed', () => {
    const file = makeFile('\n\n\nrm -rf packages/doc-retrieval-mcp/node_modules/$dep_name')
    const findings = findHostSideNamedVolumeOps([file], namedVolumePaths)
    expect(findings).toHaveLength(1)
    expect(allowlistKeyFor(findings[0])).toBe(
      `${file}:rm -rf packages/doc-retrieval-mcp/node_modules/$dep_name`
    )
  })
})

/**
 * SMI-7168 Wave 0: case table for the input-schema validation parity test. One entry per
 * exported zod input schema in @skillsmith/mcp-server: a fully populated `valid` input (the
 * test derives missing-key, wrong-type, bad-value, unknown-key cases from it) plus hand-written
 * `extras` for behaviour that derivation cannot reach (uuid and url verdicts, superRefine).
 */
import { analyzeInputSchema } from '../../src/tools/analyze.js'
import { outdatedInputSchema } from '../../src/tools/outdated.js'
import {
  teamAnalyticsDashboardInputSchema,
  teamUsageReportInputSchema,
  analyticsDashboardInputSchema,
  usageReportInputSchema,
} from '../../src/tools/analytics.js'
import { publishInputSchema } from '../../src/tools/publish.types.js'
import { getSkillInputSchema } from '../../src/tools/get-skill.js'
import { teamWorkspaceInputSchema, shareSkillInputSchema } from '../../src/tools/team-workspace.js'
import { configureSsoInputSchema, ssoSettingsInputSchema } from '../../src/tools/sso-tools.js'
import { complianceReportInputSchema } from '../../src/tools/compliance-tools.js'
import { uninstallInputSchema } from '../../src/tools/uninstall.js'
import {
  webhookConfigureInputSchema,
  apiKeyManageInputSchema,
} from '../../src/tools/integration-tools.js'
import { validateInputSchema } from '../../src/tools/validate.types.js'
import { installInputSchema } from '../../src/tools/install.types.js'
import { skillPackAuditInputSchema } from '../../src/tools/skill-pack-audit.js'
import {
  skillContentSchema,
  privateRegistryPublishInputSchema,
  privateRegistryManageInputSchema,
} from '../../src/tools/registry-tools.schemas.js'
import {
  rbacManageInputSchema,
  rbacAssignRoleInputSchema,
  rbacCreatePolicyInputSchema,
} from '../../src/tools/rbac-tools.schemas.js'
import {
  auditExportInputSchema,
  auditQueryInputSchema,
  siemExportInputSchema,
} from '../../src/tools/audit-tools.js'
import { suggestInputSchema } from '../../src/tools/suggest.js'
import { skillUpdatesInputSchema } from '../../src/tools/skill-updates.js'
import { compareInputSchema } from '../../src/tools/compare.types.js'
import { skillAuditInputSchema } from '../../src/tools/skill-audit.js'
import { skillRescanInputSchema } from '../../src/tools/skill-rescan.js'
import { publishPrivateInputSchema } from '../../src/tools/publish-private.js'
import { skillDiffInputSchema } from '../../src/tools/skill-diff.js'
import { indexLocalInputSchema } from '../../src/tools/index-local.js'
import { skillRoleSchema, recommendInputSchema } from '../../src/tools/recommend.types.js'
import { undoApplyInputSchema } from '../../src/tools/undo-apply.js'
import { applyManifestReconcileInputSchema } from '../../src/tools/apply-manifest-reconcile.js'
import { applyNamespaceRenameInputSchema } from '../../src/tools/apply-namespace-rename.js'
import { skillRecoverSourceInputSchema } from '../../src/tools/skill-recover-source.js'
import { skillInventoryAuditInputSchema } from '../../src/tools/skill-inventory-audit.js'
import { applyRecommendedEditInputSchema } from '../../src/tools/apply-recommended-edit.js'

/** The slice of a zod schema both majors share: `safeParse` and its issue shape. */
export interface SafeParseLike {
  safeParse(input: unknown): {
    success: boolean
    data?: unknown
    error?: { issues: Array<{ path: PropertyKey[]; code: string; message: string }> }
  }
}

export interface Extra {
  label: string
  input: unknown
}

export interface SchemaEntry {
  name: string
  schema: SafeParseLike
  /** A fully populated, valid input. Object entries get per-key cases derived from it. */
  valid: unknown
  extras?: Extra[]
}

const UUID_V4 = '550e8400-e29b-41d4-a716-446655440000'
const UUID_NIL_ONE = '00000000-0000-0000-0000-000000000001'
const UUID_NIL = '00000000-0000-0000-0000-000000000000'
const UUID_MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const UUID_V1 = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
// Version nibble 1, variant nibble 1: shaped like a uuid, not RFC 9562 valid.
const UUID_SHAPED_NOT_RFC = '12345678-1234-1234-1234-123456789012'

const uuidExtras = (key: string, base: Record<string, unknown>): Extra[] =>
  [
    ['uuid-v4', UUID_V4],
    ['uuid-nil-one', UUID_NIL_ONE],
    ['uuid-nil', UUID_NIL],
    ['uuid-max', UUID_MAX],
    ['uuid-v1', UUID_V1],
    ['uuid-shaped-not-rfc', UUID_SHAPED_NOT_RFC],
    ['uuid-upper', UUID_V4.toUpperCase()],
    ['uuid-braced', `{${UUID_V4}}`],
    ['uuid-empty', ''],
  ].map(([label, value]) => ({ label, input: { ...base, [key]: value } }))

const urlExtras = (key: string, base: Record<string, unknown>): Extra[] =>
  [
    ['url-https', 'https://example.com/x'],
    ['url-mailto', 'mailto:a@b.co'],
    ['url-javascript', 'javascript:alert(1)'],
    ['url-relative', '/just/a/path'],
    ['url-spaces', 'not a url'],
    ['url-empty', ''],
  ].map(([label, value]) => ({ label, input: { ...base, [key]: value } }))

const UNSAFE_INT = 2 ** 60

export const SCHEMA_ENTRIES: SchemaEntry[] = [
  {
    name: 'analyze',
    schema: analyzeInputSchema,
    valid: { path: 'src', max_files: 100, exclude_dirs: ['node_modules'], include_dev_deps: false },
  },
  { name: 'outdated', schema: outdatedInputSchema, valid: { include_deps: false } },
  {
    name: 'team_analytics_dashboard',
    schema: teamAnalyticsDashboardInputSchema,
    valid: { period: '7d' },
  },
  {
    name: 'team_usage_report',
    schema: teamUsageReportInputSchema,
    valid: { period: '7d', format: 'detailed' },
  },
  {
    name: 'analytics_dashboard',
    schema: analyticsDashboardInputSchema,
    valid: { period: '90d', includeRecommendations: true },
  },
  {
    name: 'usage_report',
    schema: usageReportInputSchema,
    valid: { period: '30d', format: 'csv' },
  },
  {
    name: 'publish',
    schema: publishInputSchema,
    valid: {
      skill_path: '/x/skill',
      check_references: false,
      reference_patterns: ['a.*'],
      create_repo: true,
      visibility: 'private',
      add_topic: true,
    },
  },
  { name: 'get_skill', schema: getSkillInputSchema, valid: { id: 'author/name' } },
  {
    name: 'team_workspace',
    schema: teamWorkspaceInputSchema,
    valid: { action: 'create', name: 'ws', description: 'd', workspaceId: UUID_V4 },
    extras: uuidExtras('workspaceId', { action: 'get' }),
  },
  {
    name: 'share_skill',
    schema: shareSkillInputSchema,
    valid: { action: 'add', workspaceId: UUID_V4, skillId: 'a/b' },
    extras: [
      ...uuidExtras('workspaceId', { action: 'list' }),
      {
        label: 'skillId-two-slashes',
        input: { action: 'add', workspaceId: UUID_V4, skillId: 'a/b/c' },
      },
      { label: 'skillId-no-slash', input: { action: 'add', workspaceId: UUID_V4, skillId: 'ab' } },
    ],
  },
  {
    name: 'configure_sso',
    schema: configureSsoInputSchema,
    valid: {
      action: 'set',
      idpMetadataUrl: 'https://idp.example.com/m',
      idpEntityId: 'e',
      protocol: 'oidc',
      domain: 'example.com',
      memberDisposition: 'convert_to_manual',
    },
    extras: urlExtras('idpMetadataUrl', { action: 'set' }),
  },
  { name: 'sso_settings', schema: ssoSettingsInputSchema, valid: { includeMetadata: true } },
  {
    name: 'compliance_report',
    schema: complianceReportInputSchema,
    valid: {
      format: 'soc2',
      period: '30d',
      includeUserActivity: false,
      backfillDependencies: true,
    },
  },
  {
    name: 'uninstall',
    schema: uninstallInputSchema,
    valid: { skillName: 'x', force: true, client: 'claude-code', scope: 'global', cwd: '/abs' },
  },
  {
    name: 'webhook_configure',
    schema: webhookConfigureInputSchema,
    valid: {
      action: 'create',
      url: 'https://e.com/h',
      events: ['a'],
      webhookId: 'w',
      description: 'd',
    },
    extras: urlExtras('url', { action: 'create' }),
  },
  {
    name: 'api_key_manage',
    schema: apiKeyManageInputSchema,
    valid: {
      action: 'create',
      name: 'k',
      keyId: 'i',
      permissions: ['p'],
      expiresIn: '30d',
    },
  },
  { name: 'validate', schema: validateInputSchema, valid: { skill_path: '/x', strict: true } },
  {
    name: 'install',
    schema: installInputSchema,
    valid: {
      skillId: 'a/b',
      force: true,
      skipScan: true,
      skipOptimize: true,
      conflictAction: 'merge',
      confirmed: true,
      client: 'claude-code',
      alsoLink: ['cursor'],
      symlink: true,
      cwd: '/abs',
      scope: 'workspace',
    },
    extras: [
      { label: 'cwd-relative', input: { skillId: 'a/b', cwd: 'relative/path' } },
      { label: 'cwd-empty', input: { skillId: 'a/b', cwd: '' } },
      { label: 'skillId-513-chars', input: { skillId: 'a'.repeat(513) } },
      { label: 'skillId-512-chars', input: { skillId: 'a'.repeat(512) } },
      { label: 'alsoLink-bad-client', input: { skillId: 'a/b', alsoLink: ['not-a-client'] } },
    ],
  },
  {
    name: 'skill_pack_audit',
    schema: skillPackAuditInputSchema,
    valid: { pack_path: '/p', check_trigger_quality: false },
  },
  { name: 'skill_content', schema: skillContentSchema, valid: { 'SKILL.md': 'x' } },
  {
    name: 'private_registry_publish',
    schema: privateRegistryPublishInputSchema,
    valid: { skillId: 'a/b', version: '1.2.3', content: { 'SKILL.md': 'x' }, description: 'd' },
    extras: [
      { label: 'skillId-dot-segment', input: { skillId: './b', version: '1.2.3', content: {} } },
      {
        label: 'skillId-dotdot-segment',
        input: { skillId: 'a/..', version: '1.2.3', content: {} },
      },
      {
        label: 'version-prerelease',
        input: { skillId: 'a/b', version: '1.2.3-rc.1', content: {} },
      },
      { label: 'version-not-semver', input: { skillId: 'a/b', version: 'v1', content: {} } },
      {
        label: 'content-non-string-value',
        input: { skillId: 'a/b', version: '1.2.3', content: { f: 1 } },
      },
    ],
  },
  {
    name: 'private_registry_manage',
    schema: privateRegistryManageInputSchema,
    valid: {
      action: 'get',
      skillId: 'a/b',
      version: '1.0.0',
      force: true,
      includeDeprecated: true,
      status: 'pending',
      note: 'n',
    },
    extras: [{ label: 'skillId-dot-segment', input: { action: 'get', skillId: 'a/.' } }],
  },
  {
    name: 'rbac_manage',
    schema: rbacManageInputSchema,
    valid: {
      action: 'set_role_permission',
      role: 'admin',
      permission: 'registry:approve',
      effect: 'allow',
    },
  },
  {
    name: 'rbac_assign_role',
    schema: rbacAssignRoleInputSchema,
    valid: { action: 'assign', memberId: 'm', role: 'member' },
  },
  {
    name: 'rbac_create_policy',
    schema: rbacCreatePolicyInputSchema,
    valid: {
      action: 'create',
      name: 'n',
      role: 'admin',
      effect: 'deny',
      resources: ['r'],
      actions: ['a'],
    },
    extras: [
      { label: 'resources-empty-string-item', input: { action: 'create', resources: [''] } },
    ],
  },
  {
    name: 'audit_export',
    schema: auditExportInputSchema,
    valid: { startDate: '2026-01-01', endDate: '2026-01-02', eventType: 'e', limit: 10 },
    extras: [
      { label: 'limit-unsafe-int', input: { limit: UNSAFE_INT } },
      { label: 'limit-1000', input: { limit: 1000 } },
      { label: 'limit-1001', input: { limit: 1001 } },
    ],
  },
  {
    name: 'audit_query',
    schema: auditQueryInputSchema,
    valid: {
      actor: 'a',
      resource: 'r',
      eventType: 'e',
      result: 'success',
      startDate: 's',
      endDate: 'e',
      limit: 10,
    },
  },
  {
    name: 'siem_export',
    schema: siemExportInputSchema,
    valid: { startDate: 's', endDate: 'e', format: 'cef' },
  },
  {
    name: 'suggest',
    schema: suggestInputSchema,
    valid: {
      project_path: '/p',
      current_file: 'f',
      recent_commands: ['c'],
      error_message: 'e',
      installed_skills: ['s'],
      limit: 5,
      session_id: 'sid',
    },
    extras: [
      {
        label: 'recent_commands-11',
        input: { project_path: '/p', recent_commands: Array(11).fill('c') },
      },
    ],
  },
  { name: 'skill_updates', schema: skillUpdatesInputSchema, valid: { skillIds: ['a/b'] } },
  { name: 'compare', schema: compareInputSchema, valid: { skill_a: 'a/b', skill_b: 'c/d' } },
  { name: 'skill_audit', schema: skillAuditInputSchema, valid: { skillIds: ['a/b'] } },
  { name: 'skill_rescan', schema: skillRescanInputSchema, valid: { skillName: 'x' } },
  { name: 'publish_private', schema: publishPrivateInputSchema, valid: { skillId: 'a/b' } },
  {
    name: 'skill_diff',
    schema: skillDiffInputSchema,
    valid: {
      skillId: 'a/b',
      oldContent: 'o',
      newContent: 'n',
      oldRiskScore: 1,
      newRiskScore: 2,
      hasLocalModifications: true,
      trustTier: 'verified',
    },
    extras: [
      {
        label: 'risk-unsafe-int',
        input: { skillId: 'a/b', oldContent: 'o', newContent: 'n', oldRiskScore: UNSAFE_INT },
      },
      {
        label: 'risk-100',
        input: { skillId: 'a/b', oldContent: 'o', newContent: 'n', newRiskScore: 100 },
      },
      {
        label: 'risk-101',
        input: { skillId: 'a/b', oldContent: 'o', newContent: 'n', newRiskScore: 101 },
      },
    ],
  },
  {
    name: 'index_local',
    schema: indexLocalInputSchema,
    valid: { force: true, skillsDir: '/d' },
  },
  { name: 'skill_role', schema: skillRoleSchema, valid: 'testing' },
  {
    name: 'recommend',
    schema: recommendInputSchema,
    valid: {
      installed_skills: ['a'],
      project_context: 'c',
      limit: 5,
      detect_overlap: false,
      min_similarity: 0.5,
      role: 'testing',
      installable_only: false,
    },
  },
  {
    name: 'undo_apply',
    schema: undoApplyInputSchema,
    valid: { count: 1 },
    extras: [
      { label: 'suggestion_id-only', input: { suggestion_id: 'x' } },
      { label: 'both-mutually-exclusive', input: { count: 1, suggestion_id: 'x' } },
      { label: 'count-zero', input: { count: 0 } },
      { label: 'count-unsafe-int', input: { count: UNSAFE_INT } },
      { label: 'count-fractional', input: { count: 1.5 } },
      { label: 'unknown-key-and-both', input: { count: 1, suggestion_id: 'x', extra: 1 } },
    ],
  },
  {
    name: 'apply_manifest_reconcile',
    schema: applyManifestReconcileInputSchema,
    valid: {
      action: 'mark_local',
      name: 'n',
      client: 'claude-code',
      scope: 'global',
      cwd: '/c',
      reason: 'r',
    },
    extras: [
      { label: 'relink-missing-source', input: { action: 'relink', name: 'n', id: 'i' } },
      { label: 'relink-complete', input: { action: 'relink', name: 'n', id: 'i', source: 's' } },
      { label: 'id-on-non-relink', input: { action: 'verify', id: 'i' } },
      { label: 'revert-bare', input: { action: 'revert' } },
      { label: 'revert-ledger', input: { action: 'revert', ledgerEntryId: 'l' } },
      { label: 'verify-bare', input: { action: 'verify' } },
      { label: 'drop-entry-no-name', input: { action: 'drop_entry' } },
      { label: 'unknown-key-and-missing-name', input: { action: 'mark_local', extra: 1 } },
    ],
  },
  {
    name: 'apply_namespace_rename',
    schema: applyNamespaceRenameInputSchema,
    valid: { auditId: 'a', collisionId: 'c', action: 'apply', confirmed: true },
    extras: [
      { label: 'custom-without-name', input: { auditId: 'a', collisionId: 'c', action: 'custom' } },
      {
        label: 'custom-with-name',
        input: { auditId: 'a', collisionId: 'c', action: 'custom', customName: 'n' },
      },
      {
        label: 'apply-with-custom-name',
        input: { auditId: 'a', collisionId: 'c', action: 'apply', customName: 'n' },
      },
      {
        label: 'unknown-key-and-custom-without-name',
        input: { auditId: 'a', collisionId: 'c', action: 'custom', extra: 1 },
      },
    ],
  },
  {
    name: 'skill_recover_source',
    schema: skillRecoverSourceInputSchema,
    valid: { only: ['a'], embedding: true, catalogHint: false },
    extras: [
      { label: 'homeDir-outside-allowed-roots', input: { homeDir: '/etc' } },
      { label: 'homeDir-empty', input: { homeDir: '' } },
      { label: 'only-empty-item', input: { only: [''] } },
    ],
  },
  {
    name: 'skill_inventory_audit',
    schema: skillInventoryAuditInputSchema,
    valid: { deep: true, projectDir: '/p', applyExclusions: false },
    extras: [
      { label: 'homeDir-outside-allowed-roots', input: { homeDir: '/etc' } },
      { label: 'homeDir-empty', input: { homeDir: '' } },
    ],
  },
  {
    name: 'apply_recommended_edit',
    schema: applyRecommendedEditInputSchema,
    valid: { auditId: 'a', collisionId: 'c', confirmed: true },
  },
]

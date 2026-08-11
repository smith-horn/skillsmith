/**
 * @fileoverview MCP tool-registration schemas for the private-registry tools
 * @module @skillsmith/mcp-server/tools/registry-tools.schemas
 * @see SMI-5949 D-12: Wave 2 Step 1 — "Extract schemas, make room"
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * A schemas-only companion (the `foo.types.ts`/`foo.action.ts` convention already used by
 * `registry-tools.content.types.ts` and `registry-tools.install-action.ts`), extracted because
 * `registry-tools.ts` sat at 492/500 lines and three later Wave 2 steps (the D-5 RPC-backed
 * `submissions`/`approve`/`reject` actions on `private_registry_manage`, plus two new
 * `RegistrySkill` fields) add roughly 25 more lines. Re-exported from `registry-tools.ts` so
 * `index.ts`'s existing import of `privateRegistryPublishToolSchema` /
 * `privateRegistryManageToolSchema` from `./tools/registry-tools.js` needs no change.
 */

export const privateRegistryPublishToolSchema = {
  name: 'private_registry_publish' as const,
  description:
    "Publish a skill to your organization's private registry. " +
    'Requires Enterprise tier (private_registry feature). ' +
    'Skills are scoped to your team namespace and published versions are immutable.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillId: {
        type: 'string',
        description: 'Skill ID in author/name format',
      },
      version: {
        type: 'string',
        description: 'Semver version to publish',
      },
      content: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Packaged skill files as a { path: text } map; must include "SKILL.md" (max 2 MB total)',
      },
      description: {
        type: 'string',
        description: 'Optional skill description',
      },
    },
    required: ['skillId', 'version', 'content'],
  },
}

export const privateRegistryManageToolSchema = {
  name: 'private_registry_manage' as const,
  description:
    'Manage skills in your private registry (list, get, install, deprecate, undeprecate, ' +
    'namespace). Requires Enterprise tier (private_registry feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'deprecate', 'undeprecate', 'namespace', 'install'],
        description:
          'Registry operation to perform. "namespace" returns your team\'s publish ' +
          'namespace (the required skill_id prefix) without attempting a publish. ' +
          '"install" downloads the skill and writes it to your skills directory.',
      },
      skillId: {
        type: 'string',
        description: 'Skill ID in author/name format (get/deprecate/undeprecate/install)',
      },
      version: {
        type: 'string',
        description: 'Version filter; "install" defaults to the most recently published',
      },
      force: { type: 'boolean', description: 'Reinstall over an existing install' },
    },
    required: ['action'],
  },
}

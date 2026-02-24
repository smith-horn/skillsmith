# Version Control & Update Notification System for Agent Skills

> **Note**: This document should be moved to `docs/internal/research/` once the private submodule is accessible.

## Context

The daily indexer report shows 26 new skills and 121 metadata updates in a single run. Teams who install agent skills currently have **zero visibility** into what changed, no way to assess update risk, and no vulnerability notification mechanism. The `updateSkill` function is a stub (`setTimeout` at `manage.ts:291`), and `hasUpdates` is hardcoded `false` (`manage.ts:98`).

This plan designs a version management system analogous to npm's `outdated`/`audit`/`update`/`diff` workflow, adapted for the unique properties of agent skills (markdown-based, natural language instructions, no transitive dependencies, but with security implications like prompt injection and data exfiltration).

---

## Jobs to Be Done

| Actor | Job | Solution |
|-------|-----|----------|
| **Skill consumer** | Know when installed skills have updates | `skillsmith outdated` CLI + `check_updates` MCP tool |
| **Skill consumer** | Understand what changed before updating | `skillsmith diff <name>` + `skill_diff` MCP tool |
| **Skill consumer** | Update safely without breaking workflows | Interactive update with backup, conflict resolution (builds on SMI-1864), rollback |
| **Skill consumer** | Be alerted about security issues | `skillsmith audit` + `audit_skill` MCP tool + advisory sync |
| **Team lead** | Ensure consistent skill versions across team | Version pinning in manifest, update policies |
| **Team lead** | Automated notification of updates | GitHub Actions workflow (weekly digest), CI integration |
| **Skill author** | Communicate what changed | Semver in SKILL.md frontmatter, changelog field |
| **Security org** | Block skills with known vulnerabilities | Advisory database, quarantine integration, auto-block on critical |

---

## Design Decisions

### 1. Content Hash as Primary Version Identity

Skills are markdown — most authors won't maintain semver. The existing codebase already SHA-256 hashes SKILL.md content (`install.conflict-helpers.ts`). Content hash is **always** computable. Semver from SKILL.md frontmatter is supported but optional.

**npm analog**: Git uses commit hashes as identity with human-readable tags layered on top. Same pattern here.

### 2. Client-Side SQLite + Server Sync (No Separate Lockfile)

The manifest at `~/.skillsmith/manifest.json` already serves as the lockfile equivalent. Skills have no transitive dependencies, so `package.json` vs `package-lock.json` separation isn't needed. Enhance the existing manifest rather than creating a new file.

### 3. Heuristic Breaking Change Detection

Since most skills won't have semver, detect breaking changes via:
- Section headings removed (H2/H3 in SKILL.md)
- Dependencies removed from frontmatter
- Risk score increase > 20 points
- Content similarity drops below threshold

When semver IS provided by the author, trust it.

### 4. Advisory System Is Registry-Managed

Simpler than a decentralized CVE system. The Skillsmith team publishes advisories, synced to clients during `skillsmith sync`. Integrates with existing quarantine system (`packages/core/src/repositories/quarantine/`).

---

## Implementation Phases

### Phase 1: Version Tracking Foundation (MVP)

**Goal**: Users can see which installed skills have updates available.

#### 1a. Database: `skill_versions` table (Migration v5)

**File**: `packages/core/src/db/schema.ts`
- Add migration v5 to `MIGRATIONS` array
- Bump `SCHEMA_VERSION` from 4 to 5

```sql
CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  semver TEXT,
  change_type TEXT CHECK(change_type IN ('major', 'minor', 'patch', 'unknown')),
  changelog TEXT,
  commit_sha TEXT,
  commit_message TEXT,
  content_length INTEGER,
  risk_score INTEGER CHECK(risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 100)),
  security_passed INTEGER,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_id ON skill_versions(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_versions_detected_at ON skill_versions(detected_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_skill_hash ON skill_versions(skill_id, content_hash);
```

#### 1b. Repository: `SkillVersionRepository`

**New file**: `packages/core/src/repositories/SkillVersionRepository.ts`

Methods:
- `recordVersion(skillId, contentHash, metadata)` — upsert a version record (idempotent via unique index)
- `getLatestVersion(skillId)` — most recent version by `detected_at`
- `getVersionHistory(skillId, limit)` — ordered list of versions
- `getVersionByHash(skillId, contentHash)` — specific version lookup
- `countVersions(skillId)` — total versions tracked

**Existing pattern to follow**: `packages/core/src/repositories/SkillRepository.ts` (constructor takes `db`, uses prepared statements)

#### 1c. Types: Add version fields to `Skill` interface

**File**: `packages/core/src/types/skill.ts`

Add optional fields to `Skill`:
```typescript
latestVersion?: string          // Most recent semver (if available)
latestContentHash?: string      // Most recent content hash
versionCount?: number           // Total tracked versions
```

#### 1d. Enhance manifest entry

**File**: `packages/mcp-server/src/tools/install.types.ts`

Make `originalContentHash` required for new installs (rename to `contentHash`), add:
```typescript
pinnedVersion?: string
autoUpdate?: boolean
updatePolicy?: 'all' | 'minor' | 'patch' | 'security-only'
```

Keep backward compat: treat missing `contentHash` as "unknown" in existing manifests.

#### 1e. Wire version recording into sync

**File**: `packages/core/src/sync/SyncEngine.ts`

After the existing upsert logic for skills, compute content hash and call `SkillVersionRepository.recordVersion()`. This captures a new version record whenever a skill's content changes during sync.

#### 1f. Wire version recording into webhook handler

**File**: `packages/core/src/webhooks/WebhookHandler.ts`

In the `onSkillChange` callback path, after indexing the skill, record the version.

#### 1g. `skillsmith outdated` CLI command

**New file**: `packages/cli/src/commands/outdated.ts`

Reads `~/.skillsmith/manifest.json`, queries registry (or local DB) for latest content hash per installed skill. Outputs table:

```
Name          Installed  Latest   Type     Age
commit-helper 1.0.0      1.2.0   minor    12 days
jest-runner   (hash:a3f) (hash:b7e) unknown  3 days
security-scan 2.0.0      3.0.0   major    45 days  [BREAKING]
```

Register in CLI entry point alongside existing `list`, `update`, `remove` commands.

#### 1h. `check_updates` MCP tool

**New file**: `packages/mcp-server/src/tools/check-updates.ts`
**Modify**: `packages/mcp-server/src/tools/index.ts` (add exports)

Returns structured JSON so Claude Code can proactively inform users: "3 of your installed skills have updates available. The security-scan skill has a major version bump."

#### 1i. Fix `updateSkill` stub

**File**: `packages/cli/src/commands/manage.ts`

Replace the `setTimeout` stub at line 291 with actual logic: fetch latest SKILL.md from source, run through install flow with `force: true` and conflict resolution. Populate `hasUpdates` field at line 98 by comparing manifest hash against latest known version.

---

### Phase 2: Diff, Risk Assessment & Pinning

**Goal**: Users can assess what changed and control update behavior.

#### 2a. Change classifier

**New file**: `packages/core/src/versioning/change-classifier.ts`

Heuristic algorithm:
- Parse SKILL.md section headings (H2/H3), frontmatter fields
- Compare old vs new: headings removed = major, headings added = minor, edits only = patch
- Risk score delta > 20 = major
- Dependency changes = major (removed) or minor (added)
- When semver is provided by author, trust it over heuristics

#### 2b. `skillsmith diff <name>`

**New file**: `packages/cli/src/commands/diff.ts`

Shows unified diff of SKILL.md between installed version and latest, with:
- Change classification header (major/minor/patch)
- Section-level summary of additions/removals
- Risk score delta
- Author-provided changelog (if present in frontmatter)

#### 2c. `skill_diff` MCP tool

**New file**: `packages/mcp-server/src/tools/diff.ts`

Structured diff for Claude Code conversation context.

#### 2d. Version pinning

**New file**: `packages/cli/src/commands/pin.ts`

- `skillsmith pin <name>` — pin to current installed version
- `skillsmith pin <name>@1.0.0` — pin to specific semver
- `skillsmith unpin <name>` — remove pin
- Writes `pinnedVersion` to manifest entry
- `skillsmith outdated` shows pinned skills with a pin indicator
- `skillsmith update --all` skips pinned skills

#### 2e. Update risk scoring

**New file**: `packages/core/src/versioning/update-risk.ts`

Computes risk level (low/medium/high/critical) per update:
- `change_type === 'major'` → +30
- Security risk score increased → +20
- Skill has local modifications → +20
- Skill is `verified` trust tier → -20
- Author-provided changelog present → -10

Returns `recommendation`: auto-update | review-then-update | manual-review-required

---

### Phase 3: Vulnerability Advisories

**Goal**: Users get `npm audit`-style vulnerability notifications for installed skills.

#### 3a. Database: `skill_advisories` table (Migration v6)

**File**: `packages/core/src/db/schema.ts`

```sql
CREATE TABLE IF NOT EXISTS skill_advisories (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  affected_versions TEXT,   -- JSON: content hashes or semver ranges
  patched_versions TEXT,    -- JSON: fixed hashes or semver
  cwe_ids TEXT,             -- JSON: e.g., ["CWE-77"]
  references TEXT,          -- JSON: URLs
  published_at TEXT NOT NULL,
  withdrawn_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

#### 3b. Advisory repository & sync

**New file**: `packages/core/src/repositories/AdvisoryRepository.ts`
**Modify**: `packages/core/src/sync/SyncEngine.ts` — fetch advisories from registry API during sync

#### 3c. `skillsmith audit`

**New file**: `packages/cli/src/commands/audit.ts`

Checks installed skills against advisory database. Output matches npm audit format:
```
critical  Prompt Injection in commit-helper
          SSA-2026-003
          Fix: skillsmith update commit-helper
```

#### 3d. `audit_skill` MCP tool

**New file**: `packages/mcp-server/src/tools/audit.ts`

Structured audit for Claude Code. Surfaces critical advisories proactively.

---

### Phase 4: CI/CD & Team Automation

**Goal**: Teams get automated notifications and can enforce update policies.

#### 4a. GitHub Actions workflow

**New file**: `.github/workflows/skill-update-check.yml`

Weekly run: checks installed skills against registry, creates GitHub Issue digest with labels (`skill-update`, `security`, `breaking`).

#### 4b. Update policies

**Modify**: `packages/cli/src/commands/sync.ts`

Apply per-skill update policies during sync:
- `manual` — never auto-update (default)
- `auto-patch` — auto-apply patch versions
- `auto-minor` — auto-apply minor + patch
- `auto-all` — auto-apply everything
- `security-only` — only auto-apply advisory fixes

---

## Critical Files Summary

| File | Action | Phase |
|------|--------|-------|
| `packages/core/src/db/schema.ts` | Add migrations v5, v6 | 1, 3 |
| `packages/core/src/types/skill.ts` | Add version fields to Skill | 1 |
| `packages/core/src/repositories/SkillVersionRepository.ts` | **New** — version history CRUD | 1 |
| `packages/core/src/sync/SyncEngine.ts` | Record versions during sync | 1 |
| `packages/core/src/webhooks/WebhookHandler.ts` | Record versions on skill change | 1 |
| `packages/mcp-server/src/tools/install.types.ts` | Enhance manifest entry | 1 |
| `packages/mcp-server/src/tools/check-updates.ts` | **New** — MCP tool | 1 |
| `packages/mcp-server/src/tools/index.ts` | Register new tools | 1, 2, 3 |
| `packages/cli/src/commands/outdated.ts` | **New** — CLI command | 1 |
| `packages/cli/src/commands/manage.ts` | Fix updateSkill stub, populate hasUpdates | 1 |
| `packages/core/src/versioning/change-classifier.ts` | **New** — breaking change detection | 2 |
| `packages/core/src/versioning/update-risk.ts` | **New** — risk scoring | 2 |
| `packages/cli/src/commands/diff.ts` | **New** — CLI diff command | 2 |
| `packages/cli/src/commands/pin.ts` | **New** — version pinning | 2 |
| `packages/mcp-server/src/tools/diff.ts` | **New** — MCP diff tool | 2 |
| `packages/core/src/repositories/AdvisoryRepository.ts` | **New** — advisory CRUD | 3 |
| `packages/cli/src/commands/audit.ts` | **New** — CLI audit command | 3 |
| `packages/mcp-server/src/tools/audit.ts` | **New** — MCP audit tool | 3 |
| `.github/workflows/skill-update-check.yml` | **New** — CI workflow | 4 |

## Existing Code to Reuse

| What | Where | How |
|------|-------|-----|
| SHA-256 content hashing | `packages/mcp-server/src/tools/install.conflict-helpers.ts` | Reuse `hashContent()` for version fingerprinting |
| Three-way merge + conflict resolution | `install.conflict-helpers.ts` (SMI-1864) | Reuse for update conflict handling |
| Backup/restore system | `install.conflict-helpers.ts` (`createSkillBackup`, `cleanupOldBackups`) | Reuse for rollback |
| Migration pattern | `packages/core/src/db/schema.ts` `MIGRATIONS` array | Follow same pattern for v5, v6 |
| Repository pattern | `packages/core/src/repositories/SkillRepository.ts` | Follow constructor/prepared-statement pattern |
| CLI command pattern | `packages/cli/src/commands/manage.ts` (Commander + chalk + ora + cli-table3) | Follow for new commands |
| MCP tool pattern | `packages/mcp-server/src/tools/compare.ts` | Follow schema + execute + format pattern |
| Security scanning | `packages/core/src/security/scanner/` | Reuse for per-version security snapshots |
| Quarantine system | `packages/core/src/repositories/quarantine/` | Integrate advisory-triggered quarantine |

## npm Pattern Mapping

| npm Feature | Skillsmith Equivalent |
|---|---|
| `npm outdated` | `skillsmith outdated` + `check_updates` MCP tool |
| `npm update` | `skillsmith update` (fix existing stub) |
| `npm diff` | `skillsmith diff` + `skill_diff` MCP tool |
| `npm audit` | `skillsmith audit` + `audit_skill` MCP tool |
| `npm audit fix` | `skillsmith audit --fix` |
| `package-lock.json` | `~/.skillsmith/manifest.json` (enhanced) |
| `npm install pkg@version` | `skillsmith install skill@version` |
| semver (major.minor.patch) | Content hash primary, semver optional from frontmatter |
| Dependabot / Renovate | GitHub Actions `skill-update-check.yml` |
| GitHub Security Advisories | `skill_advisories` table, SSA-YYYY-NNN IDs |
| `npm pack` | Content hash computed at index time |
| `.npmrc` overrides | `~/.skillsmith/config.json` update policies |

## Verification Plan

### Phase 1 verification
1. `docker exec skillsmith-dev-1 npm run build` — compiles cleanly
2. `docker exec skillsmith-dev-1 npm test` — all existing tests pass
3. New tests for `SkillVersionRepository`: create version, get latest, get history, dedup by hash
4. New tests for `outdated` command: mock manifest + DB, verify table output
5. New tests for `check_updates` MCP tool: verify structured response
6. Manual: install a skill, run sync to update it, verify `skillsmith outdated` shows the update
7. Manual: invoke `check_updates` via MCP and verify Claude surfaces the result

### Phase 2 verification
8. New tests for change classifier: known inputs → expected major/minor/patch
9. New tests for `diff` command: verify unified diff output
10. New tests for pinning: pin → outdated shows pinned → update --all skips

### Phase 3 verification
11. New tests for advisory repository: CRUD operations
12. New tests for `audit` command: mock advisories → verify output format
13. Integration: install skill with advisory → `skillsmith audit` surfaces it

### Phase 4 verification
14. GitHub Actions workflow runs in dry-run mode locally via `act`
15. `docker exec skillsmith-dev-1 npm run preflight` — full CI health check passes

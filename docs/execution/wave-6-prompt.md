# Wave 6: Release

**Issue:** SMI-1186 - Publish v0.2.0 to npm with live API
**Est. Tokens:** ~15K
**Prerequisites:** Wave 5 complete (telemetry and indexer deployed)

---

## Objective

Bump versions to 0.2.0, update documentation, and publish to npm.

## Context

- All infrastructure deployed (Waves 1-5)
- API accessible at api.skillsmith.app
- Telemetry working
- Time to ship!

---

## Pre-Release Checklist

Run these checks before proceeding:

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# 1. Verify API is accessible
curl -s https://api.skillsmith.app/functions/v1/skills-search?query=testing | jq '.total'
# Expected: number > 0

# 2. Verify tests pass
npm test
# Expected: all green

# 3. Verify build works
npm run build
# Expected: no errors

# 4. Verify telemetry (check PostHog dashboard)
# Expected: test events visible

# 5. Verify indexer workflow exists
gh workflow list | grep daily-index
# Expected: daily-index workflow listed
```

---

## Version Bump

### Files to Update

| File | Field | Old | New |
|------|-------|-----|-----|
| `packages/core/package.json` | version | 0.1.2 | 0.2.0 |
| `packages/core/src/index.ts` | VERSION | 0.1.2 | 0.2.0 |
| `packages/mcp-server/package.json` | version | 0.1.2 | 0.2.0 |
| `packages/mcp-server/src/index.ts` | (server version) | 0.1.2 | 0.2.0 |
| `packages/cli/package.json` | version | 0.1.2 | 0.2.0 |
| `packages/cli/src/index.ts` | CLI_VERSION | 0.1.2 | 0.2.0 |

### Version Bump Script

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Update package.json files
npm version 0.2.0 -w @skillsmith/core --no-git-tag-version
npm version 0.2.0 -w @skillsmith/mcp-server --no-git-tag-version
npm version 0.2.0 -w @skillsmith/cli --no-git-tag-version

# Manually update VERSION constants in source files
```

---

## CHANGELOG Update

Add to `/skillsmith/CHANGELOG.md`:

```markdown
# Changelog

## [0.2.0] - 2026-01-XX

### Added
- **Live Skill Registry**: Skills now served from live API at api.skillsmith.app
- **9,717+ Skills**: Access to full skill database indexed from GitHub
- **Telemetry**: Anonymous usage tracking (opt-out with SKILLSMITH_TELEMETRY=false)
- **API Client**: New `SkillsmithApiClient` in @skillsmith/core
- **Response Caching**: 24-hour cache for API responses
- **Daily Indexer**: Automated GitHub indexing keeps skills fresh

### Changed
- MCP server now uses live API instead of local database
- CLI commands use live API for search and recommendations

### Fixed
- N/A

### Security
- No PII collected in telemetry
- Anonymous ID generated locally

## [0.1.2] - 2026-01-06

### Added
- `sklx` command alias for CLI
- README files for npm packages
```

---

## README Updates

### packages/core/README.md

Add section:

```markdown
## Live API

As of v0.2.0, Skillsmith uses a live API at `api.skillsmith.app` to serve skills.

### Configuration

```bash
# Use default API (recommended)
# No configuration needed

# Custom API URL
export SKILLSMITH_API_URL=https://your-api.example.com

# Offline mode (use local database)
export SKILLSMITH_OFFLINE_MODE=true
```

### Telemetry

Skillsmith collects anonymous usage data to improve the product.
To opt out:

```bash
export SKILLSMITH_TELEMETRY=false
```

See [PRIVACY.md](./PRIVACY.md) for details on what data is collected.
```

### packages/mcp-server/README.md

Add section:

```markdown
## Live Skill Registry

Version 0.2.0 introduces the live skill registry with 9,717+ skills.

Skills are served from `api.skillsmith.app` and cached locally for 24 hours.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILLSMITH_API_URL` | `https://api.skillsmith.app/functions/v1` | API endpoint |
| `SKILLSMITH_OFFLINE_MODE` | `false` | Use local database instead |
| `SKILLSMITH_TELEMETRY` | `true` | Enable anonymous telemetry |
```

### packages/cli/README.md

Add section:

```markdown
## What's New in v0.2.0

- **Live Skills**: Search and install from 9,717+ real skills
- **Faster Search**: Full-text search with quality ranking
- **Privacy First**: Opt-out telemetry, no PII collected
```

---

## Git Operations

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Stage all changes
git add -A

# Commit with descriptive message
git commit -m "$(cat <<'EOF'
chore: release v0.2.0 with live skill registry

- Connect to live API at api.skillsmith.app
- Add API client with 24h response caching
- Add opt-out telemetry (PostHog)
- Add daily GitHub indexer workflow
- Document privacy policy
- Update READMEs for v0.2.0

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

# Create tag
git tag -a v0.2.0 -m "Release v0.2.0 - Live Skill Registry"

# Push with tags
git push origin main --tags
```

---

## Monitor Publish Workflow

```bash
# Watch the workflow
gh run watch

# Or check status
gh run list --workflow=publish.yml

# View logs if needed
gh run view <run-id> --log
```

---

## Post-Publish Verification

### 1. Verify npm Packages

```bash
# Check npm registry
npm view @skillsmith/core version
# Expected: 0.2.0

npm view @skillsmith/mcp-server version
# Expected: 0.2.0

npm view @skillsmith/cli version
# Expected: 0.2.0
```

### 2. Smoke Test from Clean Install

```bash
# Create temp directory
mkdir /tmp/skillsmith-test && cd /tmp/skillsmith-test

# Install fresh
npm init -y
npm i @skillsmith/mcp-server@0.2.0

# Test search
npx skillsmith search testing
# Expected: Returns skills from live API

# Test with sklx alias
npx sklx search react
# Expected: Returns skills

# Clean up
cd ~ && rm -rf /tmp/skillsmith-test
```

### 3. Verify Telemetry

1. Open PostHog dashboard
2. Look for events from the smoke test
3. Confirm `search` event appears with correct properties

---

## Linear Updates

```bash
# Mark issue done
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done 1186

# Create project completion update
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-project-update \
  "Skillsmith Phase 6A: Critical Path to Live" \
  "## Phase 6A Complete! 🚀

### v0.2.0 Published

All npm packages published with live skill registry:
- @skillsmith/core@0.2.0
- @skillsmith/mcp-server@0.2.0
- @skillsmith/cli@0.2.0

### What's Live

- **API**: api.skillsmith.app serving 9,717+ skills
- **Telemetry**: PostHog tracking anonymous usage
- **Indexer**: Daily GitHub workflow updating skills

### Next Steps

- Monitor Gate 1 metrics (2 weeks post-launch)
- npm downloads target: >200
- Daily active users target: >20

### Links

- [npm: @skillsmith/mcp-server](https://www.npmjs.com/package/@skillsmith/mcp-server)
- [PRD-V4](/docs/prd-v4.md)
- [PostHog Dashboard](https://app.posthog.com)" \
  --health onTrack
```

---

## Announcement (Optional)

### GitHub README Badge

Add to main README:

```markdown
[![npm version](https://badge.fury.io/js/%40skillsmith%2Fmcp-server.svg)](https://www.npmjs.com/package/@skillsmith/mcp-server)
```

### Social Announcement Template

```
🚀 Skillsmith v0.2.0 is live!

Discover and install 9,717+ Claude Code skills with a single command:

npm i @skillsmith/mcp-server

Features:
✅ Live skill registry
✅ Full-text search
✅ Quality scoring
✅ Privacy-first telemetry

#ClaudeCode #DeveloperTools
```

---

## Rollback Plan

If critical issues discovered:

```bash
# Unpublish within 72 hours
npm unpublish @skillsmith/core@0.2.0
npm unpublish @skillsmith/mcp-server@0.2.0
npm unpublish @skillsmith/cli@0.2.0

# Delete tag
git push --delete origin v0.2.0
git tag -d v0.2.0

# Revert commit
git revert HEAD
git push
```

---

## Success Criteria

- [ ] All packages published to npm at v0.2.0
- [ ] Packages visible on npmjs.com
- [ ] Smoke test passes (search returns results)
- [ ] Telemetry events appear in PostHog
- [ ] Linear updated with completion status
- [ ] Gate 1 monitoring begins

## Phase 6A Complete!

Proceed to Gate 1 review in 2 weeks:
- Track npm downloads
- Monitor daily active users
- Review telemetry data
- Gather user feedback

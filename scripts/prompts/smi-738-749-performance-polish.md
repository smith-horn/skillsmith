# SMI-738 to SMI-749: Performance & Polish Swarm

Execute this prompt in a separate terminal session to run the performance and polish issues as a coordinated swarm.

## Quick Start

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Run as a development swarm with parallel execution
npx claude-flow@alpha swarm "Execute SMI-738 through SMI-749 performance and polish issues for Skillsmith" \
  --strategy development \
  --mode hierarchical \
  --max-agents 8 \
  --parallel \
  --monitor
```

---

## Swarm Execution Prompt

You are executing a performance and polish swarm for the Skillsmith project. Complete all 12 issues (SMI-738 through SMI-749) using parallel agent execution.

### Project Context

- **Repository**: `/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith`
- **Project**: Skillsmith Phase 2e: Performance & Polish
- **Documentation**:
  - Engineering standards: `docs/architecture/standards.md`
  - Security standards: `docs/security/index.md`
  - Schema: `packages/core/src/db/schema.ts`

### Issues to Execute

#### Group 1: Performance & Observability (SMI-738, SMI-739, SMI-740)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-738 | Implement performance benchmarks suite | P2 |
| SMI-739 | Add OpenTelemetry tracing and metrics | P2 |
| SMI-740 | Implement health check and readiness endpoints | P2 |

**Agent**: Performance Specialist
**Files**:
- `packages/core/src/benchmarks/` (new directory)
- `packages/mcp-server/src/health/` (new directory)
- `packages/core/src/telemetry/` (new directory)

#### Group 2: MCP Tools (SMI-741, SMI-742, SMI-743)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-741 | Add MCP tool: skill_recommend | P2 |
| SMI-742 | Add MCP tool: skill_validate | P2 |
| SMI-743 | Add MCP tool: skill_compare | P3 |

**Agent**: MCP Developer
**Files**:
- `packages/mcp-server/src/tools/recommend.ts` (new)
- `packages/mcp-server/src/tools/validate.ts` (new)
- `packages/mcp-server/src/tools/compare.ts` (new)
- `packages/mcp-server/src/tools/index.ts` (update)

#### Group 3: CLI Improvements (SMI-744, SMI-745, SMI-746)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-744 | Add CLI interactive search mode | P3 |
| SMI-745 | Add CLI skill management commands | P3 |
| SMI-746 | Add CLI skill authoring commands | P3 |

**Agent**: CLI Developer
**Files**:
- `packages/cli/src/commands/search.ts` (new/update)
- `packages/cli/src/commands/manage.ts` (new)
- `packages/cli/src/commands/author.ts` (new)
- `packages/cli/src/utils/prompts.ts` (new)

#### Group 4: VS Code Extension (SMI-747, SMI-748, SMI-749)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-747 | Complete VS Code extension - Skill sidebar | P3 |
| SMI-748 | Add VS Code extension - Skill intellisense | P3 |
| SMI-749 | Add VS Code extension - Quick install command | P3 |

**Agent**: VS Code Extension Developer
**Files**:
- `packages/vscode/` (new package)
- `packages/vscode/src/sidebar/` (new)
- `packages/vscode/src/intellisense/` (new)
- `packages/vscode/src/commands/` (new)

### Execution Instructions

1. **Initialize swarm with hierarchical topology**:
```
Use mcp__claude-flow__swarm_init with topology: "hierarchical", maxAgents: 8, strategy: "specialized"
```

2. **Spawn specialized agents in parallel**:
```
Spawn these agents concurrently using Claude Code's Task tool:

Task("Performance Agent", "Execute SMI-738, SMI-739, SMI-740: Implement benchmarks, OpenTelemetry, and health checks", "performance-benchmarker")

Task("MCP Agent", "Execute SMI-741, SMI-742, SMI-743: Add skill_recommend, skill_validate, and skill_compare tools with Zod validation", "coder")

Task("CLI Agent", "Execute SMI-744, SMI-745, SMI-746: Add interactive search, skill management, and authoring commands using inquirer", "coder")

Task("VS Code Agent", "Execute SMI-747, SMI-748, SMI-749: Create VS Code extension with sidebar, intellisense, and quick install", "coder")
```

3. **Run tests after each implementation**:
```bash
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm test
```

4. **Mark issues as Done in Linear when complete**:
```bash
npm run linear:done SMI-XXX
```

### Acceptance Criteria

#### SMI-738: Performance Benchmarks
- [ ] Benchmark suite in `packages/core/src/benchmarks/`
- [ ] Benchmarks for: search (FTS5), cache operations, embedding generation
- [ ] Results in JSON format for CI comparison
- [ ] npm script: `npm run benchmark`

#### SMI-739: OpenTelemetry
- [ ] `@opentelemetry/sdk-node` added as dependency
- [ ] Trace spans for: MCP tool calls, database queries, cache operations
- [ ] Metrics for: request latency, cache hit/miss, error rates
- [ ] Environment variable: `OTEL_EXPORTER_OTLP_ENDPOINT`

#### SMI-740: Health Checks
- [ ] `/health` endpoint returns service status
- [ ] `/ready` endpoint checks database connectivity
- [ ] Response includes: uptime, version, db_connected, cache_status
- [ ] Integration tests for both endpoints

#### SMI-741: skill_recommend
- [ ] MCP tool registered as `skill_recommend`
- [ ] Input: current skills, project context
- [ ] Output: ranked recommendations with reasons
- [ ] Uses embeddings for semantic matching

#### SMI-742: skill_validate
- [ ] MCP tool registered as `skill_validate`
- [ ] Validates SKILL.md structure and frontmatter
- [ ] Checks for security issues (SSRF, path traversal patterns)
- [ ] Returns validation errors and warnings

#### SMI-743: skill_compare
- [ ] MCP tool registered as `skill_compare`
- [ ] Compares two skills side-by-side
- [ ] Shows: features, quality scores, trust tiers, size
- [ ] Returns structured comparison object

#### SMI-744: Interactive Search
- [ ] `skillsmith search -i` launches interactive mode
- [ ] Uses inquirer for prompts
- [ ] Supports filter by: trust tier, quality score, tags
- [ ] Pagination for large result sets

#### SMI-745: Skill Management
- [ ] `skillsmith list` shows installed skills
- [ ] `skillsmith update <skill>` updates a skill
- [ ] `skillsmith remove <skill>` removes with confirmation
- [ ] Color-coded output for status

#### SMI-746: Skill Authoring
- [ ] `skillsmith init` scaffolds new skill directory
- [ ] `skillsmith validate` validates local SKILL.md
- [ ] `skillsmith publish` prepares for sharing
- [ ] Templates for common skill patterns

#### SMI-747: VS Code Sidebar
- [ ] Activity bar icon for Skillsmith
- [ ] Tree view of installed skills
- [ ] Search panel with filters
- [ ] Skill detail panel

#### SMI-748: Intellisense
- [ ] SKILL.md frontmatter autocompletion
- [ ] Schema validation in editor
- [ ] Hover documentation for fields
- [ ] Snippet support for common patterns

#### SMI-749: Quick Install
- [ ] Command palette: "Skillsmith: Install Skill"
- [ ] Quick pick for search results
- [ ] Progress notification during install
- [ ] Reload prompt after install

### Dependencies

Execute in this order due to dependencies:

```
Phase 1 (Parallel - Foundation):
├── SMI-738 (Benchmarks - independent)
├── SMI-739 (OpenTelemetry - independent)
└── SMI-740 (Health checks - independent)

Phase 2 (Parallel - MCP Tools):
├── SMI-741 (skill_recommend - uses embeddings)
├── SMI-742 (skill_validate - uses security scanner)
└── SMI-743 (skill_compare - uses skill data)

Phase 3 (Parallel - CLI):
├── SMI-744 (Interactive search - uses search service)
├── SMI-745 (Skill management - uses repositories)
└── SMI-746 (Skill authoring - uses validators)

Phase 4 (Parallel - VS Code):
├── SMI-747 (Sidebar - UI foundation)
├── SMI-748 (Intellisense - depends on sidebar)
└── SMI-749 (Quick install - depends on sidebar)
```

### Final Verification

After all issues complete:

```bash
# Full test suite
docker exec skillsmith-dev-1 npm test

# Type check
docker exec skillsmith-dev-1 npm run typecheck

# Lint
docker exec skillsmith-dev-1 npm run lint

# Standards audit
docker exec skillsmith-dev-1 npm run audit:standards

# Run benchmarks
docker exec skillsmith-dev-1 npm run benchmark

# Commit all changes
git add -A
git commit -m "feat(phase-2e): implement performance and polish (SMI-738 to SMI-749)

Performance & Observability:
- SMI-738: Performance benchmarks suite
- SMI-739: OpenTelemetry tracing and metrics
- SMI-740: Health check and readiness endpoints

MCP Tools:
- SMI-741: skill_recommend tool
- SMI-742: skill_validate tool
- SMI-743: skill_compare tool

CLI Improvements:
- SMI-744: Interactive search mode
- SMI-745: Skill management commands
- SMI-746: Skill authoring commands

VS Code Extension:
- SMI-747: Skill sidebar
- SMI-748: Skill intellisense
- SMI-749: Quick install command

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push origin main
```

---

## One-Line Swarm Command

For quick execution with all context:

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith && \
npx claude-flow@alpha swarm \
  "Execute Skillsmith Phase 2e: SMI-738 (benchmarks), SMI-739 (OpenTelemetry), SMI-740 (health), SMI-741 (recommend), SMI-742 (validate), SMI-743 (compare), SMI-744 (interactive CLI), SMI-745 (CLI manage), SMI-746 (CLI author), SMI-747 (VS Code sidebar), SMI-748 (intellisense), SMI-749 (quick install). Reference docs/architecture/standards.md. Run tests after each change. Mark Linear issues done on completion." \
  --strategy development \
  --mode hierarchical \
  --max-agents 8 \
  --parallel \
  --monitor \
  --output json
```

#!/bin/bash
# SMI-738 to SMI-749: Performance & Polish Swarm
# Run this script in a separate terminal session

set -e

cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

echo "🚀 Starting Performance & Polish Swarm (SMI-738 to SMI-749)"
echo "============================================================"
echo ""
echo "Issues to execute:"
echo "  Performance & Observability:"
echo "    • SMI-738: Implement performance benchmarks suite"
echo "    • SMI-739: Add OpenTelemetry tracing and metrics"
echo "    • SMI-740: Implement health check and readiness endpoints"
echo ""
echo "  MCP Tools:"
echo "    • SMI-741: Add MCP tool: skill_recommend"
echo "    • SMI-742: Add MCP tool: skill_validate"
echo "    • SMI-743: Add MCP tool: skill_compare"
echo ""
echo "  CLI Improvements:"
echo "    • SMI-744: Add CLI interactive search mode"
echo "    • SMI-745: Add CLI skill management commands"
echo "    • SMI-746: Add CLI skill authoring commands"
echo ""
echo "  VS Code Extension:"
echo "    • SMI-747: Complete VS Code extension - Skill sidebar"
echo "    • SMI-748: Add VS Code extension - Skill intellisense"
echo "    • SMI-749: Add VS Code extension - Quick install command"
echo ""

# Run the swarm
npx claude-flow@alpha swarm \
  "Execute Skillsmith Phase 2e: Performance & Polish sprint. Complete these issues:

PHASE 1 (Performance Foundation - run in parallel):
- SMI-738: Create packages/core/src/benchmarks/ directory. Implement benchmark suite for FTS5 search, cache operations, and embedding generation. Add npm run benchmark script. Output results in JSON format.
- SMI-739: Add @opentelemetry/sdk-node dependency. Create packages/core/src/telemetry/ with trace spans for MCP calls, DB queries, cache ops. Add metrics for latency, cache hit/miss, errors. Configure via OTEL_EXPORTER_OTLP_ENDPOINT.
- SMI-740: Add /health and /ready endpoints to MCP server. Health returns uptime, version, cache_status. Ready checks database connectivity. Add integration tests.

PHASE 2 (MCP Tools - run after Phase 1):
- SMI-741: Create packages/mcp-server/src/tools/recommend.ts. Input: current skills, project context. Output: ranked recommendations using embedding similarity. Register as skill_recommend with Zod validation.
- SMI-742: Create packages/mcp-server/src/tools/validate.ts. Validates SKILL.md structure, frontmatter, security patterns. Returns errors/warnings. Register as skill_validate.
- SMI-743: Create packages/mcp-server/src/tools/compare.ts. Compares two skills: features, quality scores, trust tiers, size. Register as skill_compare.

PHASE 3 (CLI - run after Phase 2):
- SMI-744: Add -i/--interactive flag to search command. Use inquirer for prompts. Support filters: trust tier, quality, tags. Add pagination.
- SMI-745: Add list, update, remove commands to CLI. Color-coded output. Confirmation for remove. Uses SkillRepository.
- SMI-746: Add init, validate, publish commands. Scaffold new skill directories. Validate local SKILL.md. Generate sharing package.

PHASE 4 (VS Code - run after Phase 3):
- SMI-747: Create packages/vscode/ directory. Add activity bar icon, tree view for installed skills, search panel, detail panel.
- SMI-748: Add SKILL.md frontmatter autocompletion, schema validation, hover docs, snippets.
- SMI-749: Add 'Skillsmith: Install Skill' command palette entry. Quick pick for search. Progress notification. Reload prompt.

IMPORTANT CONTEXT:
- Repository: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith
- Standards: docs/architecture/standards.md
- Schema: packages/core/src/db/schema.ts
- All commands run in Docker: docker exec skillsmith-dev-1 npm run <command>
- Run docker exec skillsmith-dev-1 npm run typecheck and docker exec skillsmith-dev-1 npm test after each file change
- Mark each issue Done in Linear: docker exec skillsmith-dev-1 npm run linear:done SMI-XXX
- Use claude-flow hooks for coordination between agents" \
  --strategy development \
  --mode hierarchical \
  --max-agents 8 \
  --parallel \
  --monitor

echo ""
echo "✅ Performance & Polish Swarm Complete"

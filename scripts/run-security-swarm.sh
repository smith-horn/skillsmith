#!/bin/bash
# SMI-725 to SMI-737: Security Hardening Swarm
# Run this script in a separate terminal session

set -e

cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

echo "🔐 Starting Security Hardening Swarm (SMI-725 to SMI-737)"
echo "========================================================="
echo ""
echo "Issues to execute:"
echo "  • SMI-725: Add security scanning to CI pipeline"
echo "  • SMI-726: Standardize adapter input validation"
echo "  • SMI-727: Add pre-push formatting hook"
echo "  • SMI-728: Consolidate logger usage"
echo "  • SMI-729: Add IPv6 SSRF protection"
echo "  • SMI-730: Consolidate rate limiting"
echo "  • SMI-731: Add CSP headers"
echo "  • SMI-732: Add input sanitization library"
echo "  • SMI-733: Add structured audit logging"
echo "  • SMI-737: Create ADR-007 for rate limiting"
echo ""
echo "Skipping (already done): SMI-734, SMI-735, SMI-736"
echo ""

# Run the swarm
npx claude-flow@alpha swarm \
  "Execute Skillsmith security hardening sprint. Complete these issues in order:

PHASE 1 (Foundation - run in parallel):
- SMI-726: Create packages/core/src/utils/validation.ts with validateUrl() (SSRF checks for IPv4/IPv6) and validatePath() (traversal prevention). Migrate LocalFilesystemAdapter and RawUrlSourceAdapter to use shared utility. Add comprehensive tests.
- SMI-728: Audit all console.log/warn/error calls in packages/. Replace with createLogger() from utils/logger.ts. Ensure logger suppresses output in tests.
- SMI-737: Create docs/adr/007-rate-limiting-consolidation.md documenting the decision to consolidate rate limiting. Update docs/adr/index.md.

PHASE 2 (Implementation - run after Phase 1):
- SMI-729: Extend validation.ts validateUrl() to block IPv6 private ranges: fc00::/7, fe80::/10, ::1, ::ffff:x.x.x.x. Add tests in RawUrlSourceAdapter.security.test.ts.
- SMI-730: Create packages/core/src/utils/rateLimiter.ts with token bucket and sliding window strategies. Migrate BaseSourceAdapter to use shared utility.
- SMI-732: Add validator.js to dependencies. Create packages/core/src/utils/sanitize.ts with sanitizeHtml(), sanitizeString() functions.
- SMI-725: Update .github/workflows/ci.yml to add npm audit with --audit-level=high. Block merge on vulnerabilities. Upload report as artifact.

PHASE 3 (Integration - run after Phase 2):
- SMI-731: Add Content-Security-Policy headers to MCP server responses. Block inline scripts. Document in security/index.md.
- SMI-733: Implement audit_logs table in packages/core/src/db/schema.ts (migration version 2). Create AuditLogger utility. Add logging to source adapter fetch operations.
- SMI-727: Create .husky/pre-push hook that runs prettier --check . to catch formatting issues before push.

IMPORTANT CONTEXT:
- Repository: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith
- Security docs: docs/security/index.md (use as reference for patterns)
- Schema: packages/core/src/db/schema.ts
- All commands run in Docker: docker exec skillsmith-dev-1 npm run <command>
- Run docker exec skillsmith-dev-1 npm run typecheck and docker exec skillsmith-dev-1 npm test after each file change
- Mark each issue Done in Linear: docker exec skillsmith-dev-1 npm run linear:done SMI-XXX
- Use claude-flow hooks for coordination between agents

Skip SMI-734, SMI-735, SMI-736 - they are already complete." \
  --strategy development \
  --mode hierarchical \
  --max-agents 8 \
  --parallel \
  --monitor

echo ""
echo "✅ Security Hardening Swarm Complete"

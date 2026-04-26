# Development Documentation

Developer guides for local development, testing, and debugging.

## Documents

| Document | Description |
|----------|-------------|
| [docker-guide.md](docker-guide.md) | Container management, rebuild scenarios, native modules, troubleshooting |
| [git-crypt-guide.md](git-crypt-guide.md) | Encrypted docs, unlock, worktree setup, rebase workaround |
| [ci-reference.md](ci-reference.md) | Change classification, branch protection, Turborepo, CI scripts |
| [deployment-guide.md](deployment-guide.md) | Edge function deployment, CORS, website, monitoring & alerts |
| [claude-flow-guide.md](claude-flow-guide.md) | Agent spawning, swarm orchestration, hive mind, SPARC modes |
| [mcp-registry.md](mcp-registry.md) | MCP Registry publishing workflow and CI setup |
| [mcp-tools-guide.md](mcp-tools-guide.md) | Skillsmith MCP server tool reference, authentication, CLI |
| [edge-function-patterns.md](edge-function-patterns.md) | Supabase Edge Function patterns and Deno gotchas |
| [neural-testing.md](neural-testing.md) | Neural integration testing guide |
| [stripe-testing.md](stripe-testing.md) | Stripe CLI testing setup and webhooks |
| [stripe-billing-portal.md](stripe-billing-portal.md) | Stripe billing portal integration |
| [email-templates.md](email-templates.md) | Supabase Auth email template source (SMI-2758) |
| [publishing-guide.md](publishing-guide.md) | npm package publishing, CI workflow, local fallback |
| [vscode-publishing-guide.md](vscode-publishing-guide.md) | VS Code Marketplace publishing, PAT rotation, troubleshooting |
| [cloudinary-guide.md](cloudinary-guide.md) | Blog image upload workflow, URL transforms, folder conventions |
| [subagent-tool-permissions-guide.md](subagent-tool-permissions-guide.md) | Subagent tool access by type, foreground/background behavior |
| [supabase-migration-safety.md](supabase-migration-safety.md) | Pre/post-apply query catalog, ACCESS EXCLUSIVE lock discipline, rollback convention |
| [ruvector-dev-tooling.md](ruvector-dev-tooling.md) | `skillsmith-doc-retrieval` MCP — local semantic doc search (SMI-4417) |
| [smoke-prod-guide.md](smoke-prod-guide.md) | Post-deploy smoke harness (SMI-4459), surface manifest, failure triage |
| [vercel-deploy-hook.md](vercel-deploy-hook.md) | Vercel→GitHub `repository_dispatch` trigger for `smoke-prod.yml` |
| [e2e-staging-runbook.md](e2e-staging-runbook.md) | Device-login round-trip e2e (SMI-4460) — secret rotation, Docker carve-out |

## Quick Links

- **Docker**: Container rebuild, DNS failure, native module platform mismatch
- **Git-Crypt**: Unlock encrypted docs, worktree creation, rebase workaround
- **CI**: Branch protection, change tiers, emergency bypass
- **Deployment**: Edge function deploy commands, CORS config, website deployment
- **Claude-Flow**: Agent types, swarm init, SPARC modes, hive mind configs
- **MCP Registry**: Publishing, version sync, CI automation
- **MCP Tools**: Skillsmith MCP tool reference, auth methods, CLI usage
- **Edge Functions**: Deno patterns, Supabase query handling
- **Neural Testing**: EmbeddingService tests, ONNX runtime validation
- **Stripe**: Webhook testing, checkout flows, subscription testing, billing portal
- **Email Templates**: Supabase Auth template source, Resend SMTP setup

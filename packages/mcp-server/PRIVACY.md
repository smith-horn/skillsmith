# Privacy Policy - Skillsmith MCP Server

## Telemetry

Skillsmith includes optional, anonymous telemetry to help improve the product.

### Opt-In by Default

**Telemetry is disabled by default.** To enable:

```bash
export SKILLSMITH_TELEMETRY_ENABLED=true
export POSTHOG_API_KEY=your_api_key
```

### What We Collect

When enabled, we collect:
- **Search queries** - What skills users search for (no PII)
- **Skill views** - Which skills are viewed (skill IDs only)
- **Install events** - Which skills are installed (skill IDs only)
- **Recommendation requests** - How recommendations are used
- **Error events** - API errors for debugging (error codes, not messages)
- **Performance metrics** - Response times for optimization

### What We DON'T Collect

- Personal information (names, emails, IP addresses)
- File paths or file contents
- Code or source content
- Environment variables
- API keys or secrets
- Machine identifiers

### Anonymous User IDs

User IDs are generated anonymously using:
- Cryptographically secure UUID v4 (via `crypto.randomUUID()`)
- Generated fresh per session - **not stored persistently**
- No correlation to real identity
- Each MCP server restart generates a new anonymous ID

### Data Retention

- Events are sent to PostHog
- Data is retained for 12 months
- No data is sold to third parties

### Opt-Out

To disable telemetry:

```bash
export SKILLSMITH_TELEMETRY_ENABLED=false
```

Or simply don't set the environment variables.

### Questions

For privacy questions, please open an issue at:
https://github.com/skillsmith/skillsmith/issues

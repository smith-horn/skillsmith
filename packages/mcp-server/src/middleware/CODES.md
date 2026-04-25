# Skillsmith MCP — JSON-RPC Error Codes

Canonical Skillsmith-namespaced JSON-RPC error codes returned by the MCP
server. The codes live in the JSON-RPC reserved server-error band
(`-32000` to `-32099`); within that range we pick mid-range values so we
have headroom against future spec assignments.

Disambiguation note: each code below is paired with a stable string
`error` field in the response body. **Clients should branch on the
`error` string, not on the numeric code alone** — the codes are for
diagnostic display, the strings are the contract.

| Code | `error` body field | Meaning | Source |
|------|---------------------|---------|--------|
| `-32001` | `profile_incomplete` | User has not completed first/last name fields needed for license issuance. Client should redirect to the `complete_url` in the response. | SMI-4402 |
| `-32050` | `monthly_quota_exceeded` | User has exhausted their monthly API quota for the current billing period. Response `data.quotaInfo` carries `{ used, limit, tier, resetsAt }`. NOT retryable within the period — clients should surface upgrade or contact-support flow. | SMI-4463 |

Operational notes:

- `monthly_quota_exceeded` (`-32050`) and per-minute rate-limit errors
  (`rate_limit_exceeded`, surfaced as transport-level 429) share the
  same HTTP status code on the wire (429). The disambiguator is the
  body's `error` field. The CLI (`packages/cli/src/...` via
  `@skillsmith/core`'s `SkillsmithError(NETWORK_QUOTA_EXCEEDED)`) and
  this MCP middleware both branch on the string.
- The `data.quotaInfo` shape is stable. Adding fields is allowed;
  renaming or removing fields requires a Linear issue + migration.

## Adding a new code

1. Pick a value in `-32000` … `-32099` not already used in this table.
2. Add a `Skillsmith*` builder under `middleware/` that emits
   `{ code, error, message, data }` and an `isError: true` flag.
3. Add a row to this table with the SMI ref.
4. Wire the catch into `withLicenseAndQuota` (or the appropriate
   middleware) so handlers can throw the canonical Skillsmith error
   class and have it translated automatically.

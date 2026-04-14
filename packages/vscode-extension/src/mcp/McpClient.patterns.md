# McpClient Tool Wrapper Patterns (SMI-4194)

Before adding typed wrappers beyond the current set (`search`, `getSkill`,
`installSkill`, `uninstallSkill`), follow these conventions so the 30+ wrappers
Wave 2–4 will add stay consistent.

## 1. Response type naming

Every tool gets an `McpXxxResponse` interface in `src/mcp/types.ts`. The `Xxx`
is the camel-case tool name. Example:

```ts
// MCP tool: `skill_diff`
export interface McpSkillDiffResponse {
  leftVersion: string
  rightVersion: string
  diff: string
}
```

## 2. Wrapper signature

```ts
async skillDiff(args: { skillId: string; from: string; to: string }): Promise<McpSkillDiffResponse> {
  return this.callTool<McpSkillDiffResponse>('skill_diff', args)
}
```

- Always `async`.
- Always delegate to the private `callTool<T>`.
- Arguments as a single typed object, not positional.
- Return type is always `McpXxxResponse` (never `unknown` or inline shapes).

## 3. Error shape

`callTool` must throw `McpToolError` (to be added in Commit 4 alongside
`uninstallCommand`) on non-success responses:

```ts
export class McpToolError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly code: string, // e.g. 'TierDenied', 'SkillNotFound'
    message: string,
  ) {
    super(message)
    this.name = 'McpToolError'
  }
}
```

Command-level handlers catch `McpToolError` and branch on `.code`. No
string-matching against `.message`.

## 4. Testing

One test file per tool, co-located at `src/__tests__/mcp/<tool>.test.ts`.
Minimum coverage:

- Happy path returns the typed shape.
- Tier-denied response maps to `McpToolError` with `code: 'TierDenied'`.
- Unknown-tool response maps to `McpToolError` with `code: 'UnknownTool'`.
- MCP disconnect throws the existing `'MCP client not connected'` error.

## 5. When NOT to add a wrapper

- Tool is stubbed (`*.stub.ts` in `packages/mcp-server/src/tools/`). Wait for
  the real handler to land before wiring the extension.
- Tool requires Enterprise-only auth. Still add the wrapper (server enforces
  tier), but the command-level handler must surface the tier-denied UX spec'd
  in `docs/internal/implementation/vscode-mcp-parity.md` Design Principle 3.

## 6. Server version floor

The `initialize` response exposes `serverInfo.version` per the MCP spec. On
connect, `McpClient` should capture it (`this.serverVersion = …`) and expose
it publicly for the version-floor toast (Commit 7). No protocol change is
required — the SDK already emits this field.

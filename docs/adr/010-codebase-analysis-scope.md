# ADR-010: Codebase Analysis Scope

**Status**: Accepted
**Date**: 2025-12-30
**Deciders**: Development Team
**Related Issues**: SMI-600, SMI-602, SMI-776

## Context

The `analyze_codebase` MCP tool (SMI-600) needs to parse and understand code to provide context for skill recommendations. This requires AST parsing to extract:
- Import statements and dependencies
- Function and class definitions
- Documentation and comments
- Code patterns and frameworks used

### Options Considered

**Option A: Multi-Language with Tree-sitter**
- Use tree-sitter for universal AST parsing
- Support 5+ languages (TS, Python, Go, Rust, Java)
- Language-agnostic output format
- Higher initial complexity

**Option B: TypeScript/JavaScript Only**
- Use TypeScript compiler API
- Focus on primary use case (Claude Code users)
- Simpler implementation
- Faster time to delivery

## Decision

We chose **Option B: TypeScript/JavaScript Only**.

### Rationale

1. **Primary Use Case**: Most Claude Code users work with TS/JS codebases
2. **Native Tooling**: TypeScript compiler API provides excellent AST support
3. **Faster Delivery**: Ship working feature in one sprint
4. **Proven Path**: Can iterate based on user feedback
5. **Skill Library**: Most skills target web development workflows

### Implementation

```typescript
// packages/core/src/analysis/CodebaseAnalyzer.ts

export class CodebaseAnalyzer {
  private readonly SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

  async analyze(rootPath: string): Promise<CodebaseContext> {
    const files = await this.findSourceFiles(rootPath);

    return {
      imports: await this.extractImports(files),
      exports: await this.extractExports(files),
      functions: await this.extractFunctions(files),
      frameworks: this.detectFrameworks(files),
      patterns: this.detectPatterns(files),
    };
  }

  private async extractImports(files: string[]): Promise<ImportInfo[]> {
    const program = ts.createProgram(files, { allowJs: true });
    // Use TypeScript compiler API for accurate parsing
    return this.walkProgram(program);
  }
}
```

### Scope

| Feature | Included | Notes |
|---------|----------|-------|
| TypeScript parsing | ✅ | Full AST via tsc |
| JavaScript parsing | ✅ | Via allowJs |
| JSX/TSX support | ✅ | React patterns |
| Import extraction | ✅ | ES modules, CommonJS |
| Framework detection | ✅ | React, Next.js, Express, etc. |
| Python | ❌ | Future: SMI-776 |
| Go/Rust/Java | ❌ | Future: SMI-776 |

## Consequences

### Positive
- Faster time to market
- Simpler codebase
- Better TypeScript integration
- Focused feature set

### Negative
- Limited to JS/TS codebases
- May miss skills relevant to polyglot projects
- Users with non-JS projects underserved

### Neutral
- Clear upgrade path to multi-language
- Can add languages incrementally

## Future Work

**SMI-776: Multi-Language AST Analysis with Tree-sitter** (Parking Lot)

When ready to expand language support:
1. Integrate tree-sitter as parsing backend
2. Add Python support first (high demand)
3. Follow with Go, Rust, Java
4. Maintain consistent output format
5. Performance: < 5s for 10k file project

## References

- [SMI-600: Implement analyze_codebase MCP tool](https://linear.app/smith-horn-group/issue/SMI-600)
- [SMI-776: Multi-Language AST Analysis](https://linear.app/smith-horn-group/issue/SMI-776) (Parking Lot)
- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)

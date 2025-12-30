# ADR-009: Embedding Service Fallback Strategy

**Status**: Accepted
**Date**: 2025-12-30
**Deciders**: Development Team
**Related Issues**: SMI-754, SMI-602, SMI-604, SMI-775

## Context

The EmbeddingService is a core component used by multiple features:
- **SMI-602**: Recommend skills based on codebase analysis
- **SMI-604**: Trigger phrase overlap detection
- **SMI-754**: Replace mock data with real services

The current implementation uses mock data that returns random vectors, which is insufficient for production use. We need to decide how to integrate real embedding functionality.

### Options Considered

**Option A: Full ONNX Replacement**
- Replace mock with production ONNX model (e.g., all-MiniLM-L6-v2)
- Bundle model files (~90MB)
- Implement GPU acceleration
- Full production-ready from day one

**Option B: Fallback Mode**
- Real embeddings when ONNX model available
- Mock embeddings for tests and when model unavailable
- Gradual rollout with feature flag
- Minimal initial complexity

## Decision

We chose **Option B: Fallback Mode**.

### Rationale

1. **Test Stability**: Mock embeddings provide deterministic test results
2. **CI/CD Speed**: No large model downloads in CI pipeline
3. **Incremental Delivery**: Ship working features faster
4. **Memory Efficiency**: Model only loaded when needed
5. **Developer Experience**: Easy local development without model setup

### Implementation

```typescript
// packages/core/src/embeddings/EmbeddingService.ts

export class EmbeddingService {
  private model: OnnxModel | null = null;
  private useFallback: boolean;

  constructor(options: EmbeddingOptions = {}) {
    this.useFallback = options.useFallback ?? !this.modelExists();
  }

  async embed(text: string): Promise<number[]> {
    if (this.useFallback) {
      return this.mockEmbed(text);
    }
    return this.realEmbed(text);
  }

  private mockEmbed(text: string): number[] {
    // Deterministic mock based on text hash
    const hash = this.hashText(text);
    return Array.from({ length: 384 }, (_, i) =>
      Math.sin(hash + i) * 0.5 + 0.5
    );
  }
}
```

## Consequences

### Positive
- Tests run faster without model loading
- CI pipeline simpler and faster
- Gradual migration path to full ONNX
- Features can ship immediately

### Negative
- Mock embeddings don't provide real semantic similarity
- Production behavior differs from test behavior
- Need to verify with real model before release

### Neutral
- Configuration required to switch between modes
- Documentation needed for model setup

## Future Work

**SMI-775: Full ONNX Embedding Model Replacement** (Parking Lot)

When ready to implement Option A:
1. Bundle production ONNX model
2. Implement proper memory management
3. Add GPU acceleration support
4. Performance benchmarks
5. Migration guide from fallback mode

## References

- [SMI-754: Replace mock data with real services](https://linear.app/smith-horn-group/issue/SMI-754)
- [SMI-775: Full ONNX Embedding Model Replacement](https://linear.app/smith-horn-group/issue/SMI-775) (Parking Lot)
- [Phase 2 Implementation Plan](../architecture/phase-2-implementation.md)

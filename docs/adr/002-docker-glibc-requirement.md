# ADR-002: Docker with glibc for Native Module Compatibility

**Status**: Accepted
**Date**: 2025-12-27
**Deciders**: Skillsmith Team
**Related Issues**: SMI-617

## Context

Skillsmith uses native Node.js modules that require specific C library implementations:

- **better-sqlite3**: SQLite bindings for the database layer
- **onnxruntime-node**: ONNX runtime for embeddings/ML features

During Phase 0 development, tests failed in Docker with:

```
Error: Error loading shared library ld-linux-aarch64.so.1: No such file or directory
(needed by onnxruntime_binding.node)
```

### Root Cause

The original Dockerfile used `node:20-alpine`, which is based on Alpine Linux with **musl libc**. However, onnxruntime-node is compiled against **glibc** and cannot run on musl-based systems.

## Decision

Use `node:20-slim` (Debian-based) instead of `node:20-alpine` for the development Docker image.

### Dockerfile Change

```dockerfile
# Before (Alpine - musl libc)
FROM node:20-alpine
RUN apk add --no-cache python3 make g++ git

# After (Debian - glibc)
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*
```

## Consequences

### Positive

- All native modules work correctly (better-sqlite3, onnxruntime-node)
- Consistent behavior between local macOS/Linux and Docker
- No need for musl-compatible alternatives or WASM fallbacks
- Tests pass: 167/167 in both local and Docker environments

### Negative

- Larger image size (~200MB vs ~80MB for Alpine)
- Slightly longer build times
- More packages installed by default

### Neutral

- Development workflow unchanged (same docker commands)
- CI/CD pipeline uses same image
- No code changes required

## Alternatives Considered

### Alternative 1: Stay with Alpine + musl-compatible packages

- Pros: Smaller image, security-focused base
- Cons: onnxruntime-node doesn't publish musl binaries; would require WASM fallback
- Why rejected: Significant performance penalty for embeddings, complex setup

### Alternative 2: Multi-stage build with Alpine runtime

- Pros: Could potentially work with native compilation
- Cons: onnxruntime still needs glibc at runtime, not just build time
- Why rejected: Doesn't solve the fundamental runtime library issue

### Alternative 3: Use WASM-based alternatives

- Pros: Works everywhere, no native dependencies
- Cons: 10-100x slower for ML inference, limited ONNX operator support
- Why rejected: Unacceptable performance for production embeddings

## Implementation Notes

### Container Rebuild Required

After this change, existing containers need rebuild:

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev build --no-cache
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm install
```

### Native Module Rebuild

If native module errors persist after image change:

```bash
docker exec skillsmith-dev-1 npm rebuild
```

## References

- [onnxruntime-node GitHub Issue #13791](https://github.com/microsoft/onnxruntime/issues/13791) - Alpine/musl not supported
- [better-sqlite3 Native Modules](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)
- [Node.js Docker Best Practices](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md)

## Changelog

| Date | Change |
|------|--------|
| 2025-12-27 | Initial decision documented after Phase 0 retro |

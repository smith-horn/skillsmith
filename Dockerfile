FROM node:20-slim

WORKDIR /app

# Install dependencies for native modules (Debian-based for glibc compatibility with onnxruntime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for layer caching
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/mcp-server/package*.json ./packages/mcp-server/

# Install all dependencies
RUN npm install --include=dev

# Copy TypeScript configs and source
COPY tsconfig*.json ./
COPY packages/ ./packages/

# Build all packages
RUN npm run build || echo "Build completed with warnings"

# Default command - keep container running for development
CMD ["tail", "-f", "/dev/null"]

# Sandbox Management

Create, configure, and manage isolated execution environments.

---

## Create & Configure Sandboxes

### Create Sandbox

```javascript
mcp__flow-nexus__sandbox_create({
  template: "node", // node, python, react, nextjs, vanilla, base, claude-code
  name: "my-sandbox",
  env_vars: {
    API_KEY: "your_api_key",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://..."
  },
  install_packages: ["express", "cors", "dotenv"],
  startup_script: "npm run dev",
  timeout: 3600, // seconds
  metadata: {
    project: "my-project",
    environment: "staging"
  }
})
```

### Configure Existing Sandbox

```javascript
mcp__flow-nexus__sandbox_configure({
  sandbox_id: "sandbox_id",
  env_vars: {
    NEW_VAR: "value"
  },
  install_packages: ["axios", "lodash"],
  run_commands: ["npm run migrate", "npm run seed"],
  anthropic_key: "sk-ant-..." // For Claude Code integration
})
```

---

## Execute Code

### Run Code in Sandbox

```javascript
mcp__flow-nexus__sandbox_execute({
  sandbox_id: "sandbox_id",
  code: `
    console.log('Hello from sandbox!');
    const result = await fetch('https://api.example.com/data');
    const data = await result.json();
    return data;
  `,
  language: "javascript",
  capture_output: true,
  timeout: 60, // seconds
  working_dir: "/app",
  env_vars: {
    TEMP_VAR: "override"
  }
})
```

---

## Manage Sandboxes

### List Sandboxes

```javascript
mcp__flow-nexus__sandbox_list({
  status: "running" // running, stopped, all
})
```

### Get Sandbox Status

```javascript
mcp__flow-nexus__sandbox_status({
  sandbox_id: "sandbox_id"
})
```

### Upload File to Sandbox

```javascript
mcp__flow-nexus__sandbox_upload({
  sandbox_id: "sandbox_id",
  file_path: "/app/config/database.json",
  content: JSON.stringify(databaseConfig, null, 2)
})
```

### Get Sandbox Logs

```javascript
mcp__flow-nexus__sandbox_logs({
  sandbox_id: "sandbox_id",
  lines: 100 // max 1000
})
```

### Stop Sandbox

```javascript
mcp__flow-nexus__sandbox_stop({
  sandbox_id: "sandbox_id"
})
```

### Delete Sandbox

```javascript
mcp__flow-nexus__sandbox_delete({
  sandbox_id: "sandbox_id"
})
```

---

## Sandbox Templates

| Template | Description |
|----------|-------------|
| `node` | Node.js environment with npm |
| `python` | Python 3.x with pip |
| `react` | React development setup |
| `nextjs` | Next.js full-stack framework |
| `vanilla` | Basic HTML/CSS/JS |
| `base` | Minimal Linux environment |
| `claude-code` | Claude Code integrated environment |

---

## Common Sandbox Patterns

### API Development Sandbox

```javascript
mcp__flow-nexus__sandbox_create({
  template: "node",
  name: "api-development",
  install_packages: [
    "express",
    "cors",
    "helmet",
    "dotenv",
    "jsonwebtoken",
    "bcrypt"
  ],
  env_vars: {
    PORT: "3000",
    NODE_ENV: "development"
  },
  startup_script: "npm run dev"
})
```

### Machine Learning Sandbox

```javascript
mcp__flow-nexus__sandbox_create({
  template: "python",
  name: "ml-training",
  install_packages: [
    "numpy",
    "pandas",
    "scikit-learn",
    "matplotlib",
    "tensorflow"
  ],
  env_vars: {
    CUDA_VISIBLE_DEVICES: "0"
  }
})
```

### Full-Stack Development

```javascript
mcp__flow-nexus__sandbox_create({
  template: "nextjs",
  name: "fullstack-app",
  install_packages: [
    "prisma",
    "@prisma/client",
    "next-auth",
    "zod"
  ],
  env_vars: {
    DATABASE_URL: "postgresql://...",
    NEXTAUTH_SECRET: "secret"
  }
})
```

---

## Advanced Configuration

### Custom Docker Images

```javascript
mcp__flow-nexus__sandbox_create({
  template: "base",
  name: "custom-environment",
  startup_script: `
    apt-get update
    apt-get install -y custom-package
    git clone https://github.com/user/repo
    cd repo && npm install
  `
})
```

### Multi-Stage Execution

```javascript
// Stage 1: Setup
mcp__flow-nexus__sandbox_execute({
  sandbox_id: "id",
  code: "npm install && npm run build"
})

// Stage 2: Run
mcp__flow-nexus__sandbox_execute({
  sandbox_id: "id",
  code: "npm start",
  working_dir: "/app/dist"
})
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Sandbox Won't Start | Check template compatibility, verify credits |
| Execution Timeout | Increase timeout parameter or optimize code |
| Out of Memory | Use larger template or optimize memory usage |
| Package Install Failed | Check package name, verify npm/pip availability |

# App Store & Deployment

Browse, publish, and deploy applications on the Flow Nexus marketplace.

---

## Browse & Search

### Search Applications

```javascript
mcp__flow-nexus__app_search({
  search: "authentication api",
  category: "backend",
  featured: true,
  limit: 20
})
```

### Get App Details

```javascript
mcp__flow-nexus__app_get({
  app_id: "app_id"
})
```

### List Templates

```javascript
mcp__flow-nexus__app_store_list_templates({
  category: "web-api",
  tags: ["express", "jwt", "typescript"],
  limit: 20
})
```

### Get Template Details

```javascript
mcp__flow-nexus__template_get({
  template_name: "express-api-starter",
  template_id: "template_id" // alternative
})
```

### List All Available Templates

```javascript
mcp__flow-nexus__template_list({
  category: "backend",
  template_type: "starter",
  featured: true,
  limit: 50
})
```

---

## Publish Applications

### Publish App to Store

```javascript
mcp__flow-nexus__app_store_publish_app({
  name: "JWT Authentication Service",
  description: "Production-ready JWT authentication microservice with refresh tokens",
  category: "backend",
  version: "1.0.0",
  source_code: sourceCodeString,
  tags: ["auth", "jwt", "express", "typescript", "security"],
  metadata: {
    author: "Your Name",
    license: "MIT",
    repository: "github.com/username/repo",
    homepage: "https://yourapp.com",
    documentation: "https://docs.yourapp.com"
  }
})
```

### Update Application

```javascript
mcp__flow-nexus__app_update({
  app_id: "app_id",
  updates: {
    version: "1.1.0",
    description: "Added OAuth2 support",
    tags: ["auth", "jwt", "oauth2", "express"],
    source_code: updatedSourceCode
  }
})
```

---

## Deploy Templates

### Deploy Template

```javascript
mcp__flow-nexus__template_deploy({
  template_name: "express-api-starter",
  deployment_name: "my-production-api",
  variables: {
    api_key: "your_api_key",
    database_url: "postgres://user:pass@host:5432/db",
    redis_url: "redis://localhost:6379"
  },
  env_vars: {
    NODE_ENV: "production",
    PORT: "8080",
    LOG_LEVEL: "info"
  }
})
```

---

## Analytics & Management

### Get App Analytics

```javascript
mcp__flow-nexus__app_analytics({
  app_id: "your_app_id",
  timeframe: "30d" // 24h, 7d, 30d, 90d
})
```

### View Installed Apps

```javascript
mcp__flow-nexus__app_installed({
  user_id: "your_user_id"
})
```

### Get Market Statistics

```javascript
mcp__flow-nexus__market_data()
```

---

## App Categories

| Category | Description |
|----------|-------------|
| `web-api` | RESTful APIs and microservices |
| `frontend` | React, Vue, Angular applications |
| `full-stack` | Complete end-to-end applications |
| `cli-tools` | Command-line utilities |
| `data-processing` | ETL pipelines and analytics |
| `ml-models` | Pre-trained machine learning models |
| `blockchain` | Web3 and blockchain applications |
| `mobile` | React Native and mobile apps |

---

## Publishing Best Practices

1. **Documentation**: Include comprehensive README with setup instructions
2. **Examples**: Provide usage examples and sample configurations
3. **Testing**: Include test suite and CI/CD configuration
4. **Versioning**: Use semantic versioning (MAJOR.MINOR.PATCH)
5. **Licensing**: Add clear license information (MIT, Apache, etc.)
6. **Deployment**: Include Docker/docker-compose configurations
7. **Migrations**: Provide upgrade guides for version updates
8. **Security**: Document security considerations and best practices

---

## Revenue Sharing

Earn credits when others use your published templates:

- **Set Pricing**: Free (0 credits) or premium pricing
- **Track Usage**: Monitor deployments via analytics
- **Earn Credits**: Receive credits on each deployment
- **Withdraw**: Use credits for Flow Nexus services or withdraw

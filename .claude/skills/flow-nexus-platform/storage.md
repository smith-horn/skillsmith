# Storage & Real-time

File storage, real-time subscriptions, execution monitoring, and system utilities.

---

## File Storage

### Upload File

```javascript
mcp__flow-nexus__storage_upload({
  bucket: "my-bucket", // public, private, shared, temp
  path: "data/users.json",
  content: JSON.stringify(userData, null, 2),
  content_type: "application/json"
})
```

### List Files

```javascript
mcp__flow-nexus__storage_list({
  bucket: "my-bucket",
  path: "data/", // prefix filter
  limit: 100
})
```

### Get Public URL

```javascript
mcp__flow-nexus__storage_get_url({
  bucket: "my-bucket",
  path: "data/report.pdf",
  expires_in: 3600 // seconds (default: 1 hour)
})
```

### Delete File

```javascript
mcp__flow-nexus__storage_delete({
  bucket: "my-bucket",
  path: "data/old-file.json"
})
```

---

## Storage Buckets

| Bucket | Description |
|--------|-------------|
| `public` | Publicly accessible files (CDN-backed) |
| `private` | User-only access with authentication |
| `shared` | Team collaboration with ACL |
| `temp` | Auto-deleted after 24 hours |

---

## Real-time Subscriptions

### Subscribe to Database Changes

```javascript
mcp__flow-nexus__realtime_subscribe({
  table: "tasks",
  event: "INSERT", // INSERT, UPDATE, DELETE, *
  filter: "status=eq.pending AND priority=eq.high"
})
```

### List Active Subscriptions

```javascript
mcp__flow-nexus__realtime_list()
```

### Unsubscribe

```javascript
mcp__flow-nexus__realtime_unsubscribe({
  subscription_id: "subscription_id"
})
```

---

## Execution Monitoring

### Subscribe to Execution Stream

```javascript
mcp__flow-nexus__execution_stream_subscribe({
  stream_type: "claude-flow-swarm", // claude-code, claude-flow-swarm, claude-flow-hive-mind, github-integration
  deployment_id: "deployment_id",
  sandbox_id: "sandbox_id" // alternative
})
```

### Get Stream Status

```javascript
mcp__flow-nexus__execution_stream_status({
  stream_id: "stream_id"
})
```

### List Generated Files

```javascript
mcp__flow-nexus__execution_files_list({
  stream_id: "stream_id",
  created_by: "claude-flow", // claude-code, claude-flow, git-clone, user
  file_type: "javascript" // filter by extension
})
```

### Get File Content from Execution

```javascript
mcp__flow-nexus__execution_file_get({
  file_id: "file_id",
  file_path: "/path/to/file.js" // alternative
})
```

---

## System Utilities

### Queen Seraphina AI Assistant

```javascript
mcp__flow-nexus__seraphina_chat({
  message: "How should I architect a distributed microservices system?",
  enable_tools: true, // Allow her to create swarms, deploy code, etc.
  conversation_history: [
    { role: "user", content: "I need help with system architecture" },
    { role: "assistant", content: "I can help you design that. What are your requirements?" }
  ]
})
```

Queen Seraphina is an advanced AI assistant with:
- Deep expertise in distributed systems
- Ability to create swarms and orchestrate agents
- Code deployment and architecture design
- Multi-turn conversation with context retention
- Tool usage for hands-on assistance

### Check System Health

```javascript
mcp__flow-nexus__system_health()
```

### View Audit Logs

```javascript
mcp__flow-nexus__audit_log({
  user_id: "your_user_id", // optional filter
  limit: 100
})
```

---

## Advanced Storage Patterns

### Large File Upload (Chunked)

```javascript
const chunkSize = 5 * 1024 * 1024 // 5MB chunks
for (let i = 0; i < chunks.length; i++) {
  await mcp__flow-nexus__storage_upload({
    bucket: "private",
    path: `large-file.bin.part${i}`,
    content: chunks[i]
  })
}
```

### Storage Lifecycle

```javascript
// Upload to temp for processing
mcp__flow-nexus__storage_upload({
  bucket: "temp",
  path: "processing/data.json",
  content: data
})

// Move to permanent storage after processing
mcp__flow-nexus__storage_upload({
  bucket: "private",
  path: "archive/processed-data.json",
  content: processedData
})
```

---

## Advanced Real-time Patterns

### Multi-Table Sync

```javascript
const tables = ["users", "tasks", "notifications"]
tables.forEach(table => {
  mcp__flow-nexus__realtime_subscribe({
    table,
    event: "*",
    filter: `user_id=eq.${userId}`
  })
})
```

### Event-Driven Workflows

```javascript
// Subscribe to task completion
mcp__flow-nexus__realtime_subscribe({
  table: "tasks",
  event: "UPDATE",
  filter: "status=eq.completed"
})

// Trigger notification workflow on event
// (handled by your application logic)
```

---
name: varlock
version: "1.0.0"
description: Secure environment variable management with Varlock. Use when handling secrets, API keys, credentials, or any sensitive configuration. Ensures secrets are never exposed in terminals, logs, traces, or Claude's context. Trigger phrases include "environment variables", "secrets", ".env", "API key", "credentials", "sensitive", "Varlock".
category: security
tags:
  - security
  - secrets
  - environment-variables
  - credentials
  - configuration
author: Smith Horn
repository: https://github.com/dmno-dev/varlock
compatibility:
  - claude-code
  - cursor
  - claude
---

# Varlock Security Skill

Secure-by-default environment variable management for Claude Code sessions.

> **Repository**: https://github.com/dmno-dev/varlock
> **Documentation**: https://varlock.dev

## Core Principle: Secrets Never Exposed

When working with Claude, secrets must NEVER appear in:
- Terminal output
- Claude's input/output context
- Log files or traces
- Git commits or diffs
- Error messages

This skill ensures all sensitive data is properly protected.

---

## CRITICAL: Security Rules for Claude

### Rule 1: Never Echo Secrets

```bash
# ❌ NEVER DO THIS - exposes secret to Claude's context
echo $CLERK_SECRET_KEY
cat .env | grep SECRET
printenv | grep API
grep SECRET .env
head .env
tail .env
sed -n '1,5p' .env
awk '{print}' .env
strings .env
python3 -c "print(open('.env').read())"
docker exec <container> cat /app/.env   # a bind-mounted repo root reaches the identical file

# ✅ DO THIS - validates without exposing
varlock load --quiet && echo "✓ Secrets validated"
```

### Rule 2: Never Read .env Directly

```bash
# ❌ NEVER DO THIS - exposes all secrets
cat .env
less .env
head .env
tail .env
sed .env
awk '{print}' .env
grep <pattern> .env
strings .env
Read tool on .env file
docker exec <container> cat .env    # or any wrapper around the commands above

# ✅ DO THIS - read schema (safe) not values
cat .env.schema
varlock load   # default pretty format only — masked. NEVER --format json/json-full/json-full-compact/env (those print unmasked, raw values)
```

### Rule 3: Use Varlock for Validation

```bash
# ❌ NEVER DO THIS - exposes secret in error
test -n "$API_KEY" && echo "Key: $API_KEY"

# ✅ DO THIS - Varlock validates and masks
varlock load
# Output shows: API_KEY 🔐sensitive └ ▒▒▒▒▒
```

> **Format matters.** Only `varlock load`'s **default pretty format** — the output shown above — redacts sensitive values. `varlock load --format json`, `--format json-full`, `--format json-full-compact`, and `--format env` all print **unmasked, raw values**. Never run `varlock load` with any of those four `--format` values, and never suggest them to a user as a "safe" way to inspect config.

### Rule 4: Never Include Secrets in Commands

```bash
# ❌ NEVER DO THIS - secret in command history
curl -H "Authorization: Bearer sk_live_xxx" https://api.example.com

# ✅ DO THIS - use environment variable
curl -H "Authorization: Bearer $API_KEY" https://api.example.com
# Or better: varlock run -- curl ...
```

---

## Quick Start

### Installation

```bash
# Install Varlock CLI
curl -sSfL https://varlock.dev/install.sh | sh -s -- --force-no-brew

# Add to PATH (add to ~/.zshrc or ~/.bashrc)
export PATH="$HOME/.varlock/bin:$PATH"

# Verify
varlock --version
```

### Initialize Project

```bash
# Create .env.schema from existing .env
varlock init

# Or create manually
touch .env.schema
```

---

## Schema File: .env.schema

The schema defines types, validation, and sensitivity for each variable.

### Basic Structure

```bash
# Global defaults
# @defaultSensitive=true @defaultRequired=infer

# Application
# @type=enum(development,staging,production) @sensitive=false
NODE_ENV=development

# @type=port @sensitive=false
PORT=3000

# Database - SENSITIVE
# @type=url @required
DATABASE_URL=

# @type=string @required @sensitive
DATABASE_PASSWORD=

# API Keys - SENSITIVE
# @type=string(startsWith=sk_) @required @sensitive
STRIPE_SECRET_KEY=

# @type=string(startsWith=pk_) @sensitive=false
STRIPE_PUBLISHABLE_KEY=
```

### Security Annotations

| Annotation | Effect | Use For |
|------------|--------|---------|
| `@sensitive` | Redacted in all output | API keys, passwords, tokens |
| `@sensitive=false` | Shown in logs | Public keys, non-secret config |
| `@defaultSensitive=true` | All vars sensitive by default | High-security projects |

### Type Annotations

| Type | Validates | Example |
|------|-----------|---------|
| `string` | Any string | `@type=string` |
| `string(startsWith=X)` | Prefix validation | `@type=string(startsWith=sk_)` |
| `string(contains=X)` | Substring validation | `@type=string(contains=+clerk_test)` |
| `url` | Valid URL | `@type=url` |
| `port` | 1-65535 | `@type=port` |
| `boolean` | true/false | `@type=boolean` |
| `enum(a,b,c)` | One of values | `@type=enum(dev,prod)` |

---

## Safe Commands for Claude

### Validating Environment

```bash
# Check all variables (safe ONLY in the default pretty format - masks sensitive values)
varlock load

# Quiet mode (no output on success)
varlock load --quiet

# Check specific environment (still default pretty format - masked)
varlock load --env=production

# ❌ NEVER add --format json / --format json-full / --format json-full-compact / --format env
# to any of the commands above — all four print unmasked, raw values
```

### Running Commands with Secrets

```bash
# Inject validated env into command
varlock run -- npm start
varlock run -- node script.js
varlock run -- pytest

# Secrets are available to the command but never printed
```

### Checking Schema (Safe)

```bash
# Schema is safe to read - contains no values
cat .env.schema

# List expected variables
grep "^[A-Z]" .env.schema
```

---

## Common Patterns

### Pattern 1: Validate Before Operations

```bash
# Always validate environment first (quiet mode, default format)
varlock load --quiet || {
  echo "❌ Environment validation failed"
  exit 1
}

# Then proceed with operation
npm run build
```

### Pattern 2: Safe Secret Rotation

```bash
# 1. Update secret in external source (1Password, AWS, etc.)
# 2. Update .env file manually (don't use Claude for this)
# 3. Validate new value works
varlock load   # default pretty format — masked; never --format json/json-full/json-full-compact/env

# 4. If using GitHub Secrets, sync (values not shown)
./scripts/update-github-secrets.sh
```

### Pattern 3: CI/CD Integration

```yaml
# GitHub Actions - secrets from GitHub Secrets
- name: Validate environment
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    API_KEY: ${{ secrets.API_KEY }}
  run: varlock load --quiet   # default format; never add --format json/json-full/json-full-compact/env
```

### Pattern 4: Docker Integration

```dockerfile
# Install Varlock in container
RUN curl -sSfL https://varlock.dev/install.sh | sh -s -- --force-no-brew \
    && ln -s /root/.varlock/bin/varlock /usr/local/bin/varlock

# Validate at container start
CMD ["varlock", "run", "--", "npm", "start"]
```

---

## Handling Secret-Related Tasks

### When User Asks to "Check if API key is set"

```bash
# ✅ Safe approach (default pretty format only)
varlock load 2>&1 | grep "API_KEY"
# Shows: ✅ API_KEY 🔐sensitive └ ▒▒▒▒▒
# Never combine with --format json/json-full/json-full-compact/env — those print unmasked values

# ❌ Never do
echo $API_KEY
```

### When User Asks to "Debug authentication"

```bash
# ✅ Safe approach - check presence and format (default pretty format only)
varlock load  # Validates types and required fields

# Check if key has correct prefix (without showing value)
varlock load 2>&1 | grep -E "(CLERK|AUTH)"

# ❌ Never do
printenv | grep KEY
```

### When User Asks to "Update a secret"

```
Claude should respond:
"I cannot directly modify secrets for security reasons. Please:
1. Update the value in your .env file manually
2. Or update in your secrets manager (1Password, AWS, etc.)
3. Then run `varlock load` (default pretty format — masked; never `--format json`/`json-full`/`json-full-compact`/`env`) to validate

I can help you update the .env.schema if you need to add new variables."
```

### When User Asks to "Show me the .env file"

```
Claude should respond:
"I won't read .env files directly as they contain secrets — not with cat, grep, head, tail, sed, awk, strings, an inline interpreter, or a docker exec wrapper around any of them. Instead:
- Run `varlock load` (default pretty format only — masked; never `--format json`/`json-full`/`json-full-compact`/`env`, which print unmasked values) to see masked values
- Run `cat .env.schema` to see the schema (safe)
- I can help you modify .env.schema if needed"
```

---

## External Secret Sources

### 1Password Integration

```bash
# In .env.schema
# @type=string @sensitive
API_KEY=exec('op read "op://vault/item/field"')
```

### AWS Secrets Manager

```bash
# In .env.schema
# @type=string @sensitive
DB_PASSWORD=exec('aws secretsmanager get-secret-value --secret-id prod/db')
```

### Environment-Specific Values

```bash
# In .env.schema
# @type=url
API_URL=env('API_URL_${NODE_ENV}', 'http://localhost:3000')
```

---

## Troubleshooting

### "varlock: command not found"

```bash
# Check installation
ls ~/.varlock/bin/varlock

# Add to PATH
export PATH="$HOME/.varlock/bin:$PATH"

# Or use full path
~/.varlock/bin/varlock load
```

### "Schema validation failed"

```bash
# Check which variables are missing/invalid (default pretty format — masked)
varlock load   # Shows detailed errors; never --format json/json-full/json-full-compact/env, which print unmasked values

# Common fixes:
# - Add missing required variables to .env
# - Fix type mismatches (port must be number)
# - Check string prefixes match schema
```

### "Sensitive value exposed in logs"

```bash
# 1. Rotate the exposed secret immediately
# 2. Check .env.schema has @sensitive annotation
# 3. Ensure using varlock commands in the default pretty format —
#    not echo/cat/grep/head/tail/sed/awk/strings/an inline interpreter,
#    a docker exec wrapper around any of them, or varlock load --format json/json-full/json-full-compact/env

# Add missing sensitivity:
# Before: API_KEY=
# After:  # @type=string @sensitive
#         API_KEY=
```

---

## npm Scripts

Add these to your package.json:

```json
{
  "scripts": {
    "env:validate": "varlock load",
    "env:check": "varlock load --quiet || echo 'Environment validation failed'",
    "prestart": "varlock load --quiet",
    "start": "varlock run -- node server.js"
  }
}
```

> `env:validate` and every other bare `varlock load` invocation above are safe **only** in the default pretty format shown here. Never change these scripts to add `--format json`, `--format json-full`, `--format json-full-compact`, or `--format env` — all four print unmasked, raw values.

---

## Security Checklist for New Projects

- [ ] Install Varlock CLI
- [ ] Create `.env.schema` with all variables defined
- [ ] Mark all secrets with `@sensitive` annotation
- [ ] Add `@defaultSensitive=true` to schema header
- [ ] Add `.env` to `.gitignore`
- [ ] Commit `.env.schema` to version control
- [ ] Add `npm run env:validate` to CI/CD
- [ ] Document secret rotation procedure
- [ ] Never use `cat`, `grep`, `head`, `tail`, `sed`, `awk`, `strings`, an inline interpreter, or a `docker exec` wrapper to read `.env` directly, and never `echo $SECRET`, in Claude sessions
- [ ] Never run `varlock load --format json` / `json-full` / `json-full-compact` / `env` — only the default pretty format is masked

---

## Quick Reference Card

| Task | Safe Command |
|------|-------------|
| Validate all env vars | `varlock load` (default pretty format only) |
| Quiet validation | `varlock load --quiet` |
| Run with env | `varlock run -- <cmd>` |
| View schema | `cat .env.schema` |
| Check specific var | `varlock load \| grep VAR_NAME` (default pretty format only) |

> Never add `--format json`, `--format json-full`, `--format json-full-compact`, or `--format env` to any `varlock load` command above — those four print unmasked, raw values.

| Never Do | Why |
|----------|-----|
| `cat .env` | Exposes all secrets |
| `grep <pattern> .env` | Exposes all secrets |
| `head .env` / `tail .env` | Exposes all secrets |
| `sed` / `awk` on `.env` | Exposes all secrets |
| `strings .env` | Exposes all secrets |
| `echo $SECRET` | Exposes to Claude context |
| `printenv \| grep` | Exposes matching secrets |
| Inline interpreter reading `.env` (e.g. `python3 -c`) | Exposes all secrets |
| `docker exec <container> cat /app/.env` (or any wrapper around a command above) | Same file via bind mount — exposes all secrets |
| Read tool on .env | Secrets in Claude's context |
| Hardcode in commands | In shell history |
| `varlock load --format json` / `json-full` / `json-full-compact` / `env` | Prints **unmasked** raw values |

---

*Last updated: September 1, 2026*
*Secure-by-default environment management for Claude Code*

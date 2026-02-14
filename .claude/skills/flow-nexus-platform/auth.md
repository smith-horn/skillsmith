# Authentication & User Management

User registration, login, password management, and profile configuration.

---

## Registration & Login

### Register New Account

```javascript
mcp__flow-nexus__user_register({
  email: "user@example.com",
  password: "secure_password",
  full_name: "Your Name",
  username: "unique_username" // optional
})
```

### Login

```javascript
mcp__flow-nexus__user_login({
  email: "user@example.com",
  password: "your_password"
})
```

### Check Authentication Status

```javascript
mcp__flow-nexus__auth_status({ detailed: true })
```

### Logout

```javascript
mcp__flow-nexus__user_logout()
```

---

## Password Management

### Request Password Reset

```javascript
mcp__flow-nexus__user_reset_password({
  email: "user@example.com"
})
```

### Update Password with Token

```javascript
mcp__flow-nexus__user_update_password({
  token: "reset_token_from_email",
  new_password: "new_secure_password"
})
```

### Verify Email

```javascript
mcp__flow-nexus__user_verify_email({
  token: "verification_token_from_email"
})
```

---

## Profile Management

### Get User Profile

```javascript
mcp__flow-nexus__user_profile({
  user_id: "your_user_id"
})
```

### Update Profile

```javascript
mcp__flow-nexus__user_update_profile({
  user_id: "your_user_id",
  updates: {
    full_name: "Updated Name",
    bio: "AI Developer and researcher",
    github_username: "yourusername",
    twitter_handle: "@yourhandle"
  }
})
```

### Get User Statistics

```javascript
mcp__flow-nexus__user_stats({
  user_id: "your_user_id"
})
```

### Upgrade User Tier

```javascript
mcp__flow-nexus__user_upgrade({
  user_id: "your_user_id",
  tier: "pro" // pro, enterprise
})
```

---

## Authentication Management

### Initialize Authentication

```javascript
mcp__flow-nexus__auth_init({
  mode: "user" // user, service
})
```

---

## Security Best Practices

1. **Strong Passwords**: Use passwords with mixed case, numbers, and symbols
2. **Enable 2FA**: When available, enable two-factor authentication
3. **Regular Rotation**: Rotate passwords and tokens periodically
4. **Verify Email**: Always verify email for account recovery
5. **Audit Logs**: Review login history via audit logs

---

## Common Issues

| Issue | Solution |
|-------|----------|
| Login Failed | Check email/password, verify email first |
| Token Expired | Re-login to get fresh tokens |
| Permission Denied | Check tier limits, upgrade if needed |
| Email Not Verified | Check spam folder, request new verification |

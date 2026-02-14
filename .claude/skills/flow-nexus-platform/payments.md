# Payments & Credits

Credit balance, billing, subscriptions, and cost optimization.

---

## Balance & Credits

### Check Credit Balance

```javascript
mcp__flow-nexus__check_balance()
```

### Check rUv Balance

```javascript
mcp__flow-nexus__ruv_balance({
  user_id: "your_user_id"
})
```

### View Transaction History

```javascript
mcp__flow-nexus__ruv_history({
  user_id: "your_user_id",
  limit: 100
})
```

### Get Payment History

```javascript
mcp__flow-nexus__get_payment_history({
  limit: 50
})
```

---

## Purchase Credits

### Create Payment Link

```javascript
mcp__flow-nexus__create_payment_link({
  amount: 50 // USD, minimum $10
})
// Returns secure Stripe payment URL
```

---

## Auto-Refill Configuration

### Enable Auto-Refill

```javascript
mcp__flow-nexus__configure_auto_refill({
  enabled: true,
  threshold: 100,  // Refill when credits drop below 100
  amount: 50       // Purchase $50 worth of credits
})
```

### Disable Auto-Refill

```javascript
mcp__flow-nexus__configure_auto_refill({
  enabled: false
})
```

---

## Credit Pricing

### Service Costs

| Service | Cost |
|---------|------|
| Swarm Operations | 1-10 credits/hour |
| Sandbox Execution | 0.5-5 credits/hour |
| Neural Training | 5-50 credits/job |
| Workflow Runs | 0.1-1 credit/execution |
| Storage | 0.01 credits/GB/day |
| API Calls | 0.001-0.01 credits/request |

---

## Earning Credits

### Ways to Earn

| Method | Credits |
|--------|---------|
| Complete Challenges | 10-500 per challenge |
| Publish Templates | Earn when others deploy |
| Referral Program | Bonus for user invites |
| Daily Login | 5-10 credits daily |
| Achievements | 50-1000 for milestones |
| App Store Sales | Revenue share from paid templates |

### Earn Credits Programmatically

```javascript
mcp__flow-nexus__app_store_earn_ruv({
  user_id: "your_user_id",
  amount: 100,
  reason: "Completed expert algorithm challenge",
  source: "challenge" // challenge, app_usage, referral, etc.
})
```

---

## Subscription Tiers

### Free Tier

- 100 free credits monthly
- Basic sandbox access (2 concurrent)
- Limited swarm agents (3 max)
- Community support
- 1GB storage

### Pro Tier ($29/month)

- 1000 credits monthly
- Priority sandbox access (10 concurrent)
- Unlimited swarm agents
- Advanced workflows
- Email support
- 10GB storage
- Early access to features

### Enterprise Tier (Custom Pricing)

- Unlimited credits
- Dedicated compute resources
- Custom neural models
- 99.9% SLA guarantee
- Priority 24/7 support
- Unlimited storage
- White-label options
- On-premise deployment

---

## Cost Optimization Tips

1. **Use Smaller Sandboxes**: Choose appropriate templates (base vs full-stack)
2. **Optimize Neural Training**: Tune hyperparameters, reduce epochs
3. **Batch Operations**: Group workflow executions together
4. **Clean Up Resources**: Delete unused sandboxes and storage
5. **Monitor Usage**: Check `user_stats` regularly
6. **Use Free Templates**: Leverage community templates
7. **Schedule Off-Peak**: Run heavy jobs during low-cost periods

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Payment Failed | Check payment method, sufficient funds |
| Credits Not Applied | Allow 5-10 minutes for processing |
| Auto-refill Not Working | Verify payment method on file |

# Pair Programming Examples

Real-world session examples demonstrating different workflows.

---

## Example 1: Feature Implementation

Implementing user authentication with JWT tokens.

**Session Setup:**
```bash
claude-flow pair --start \
  --mode switch \
  --agent senior-dev \
  --focus implement \
  --verify \
  --test
```

**Session Flow:**
```
👥 Starting pair programming for authentication feature...

[DRIVER: You - 10 minutes]
/explain JWT authentication flow
> AI explains JWT concepts and best practices

/suggest implementation approach
> AI suggests using middleware pattern with refresh tokens

# You write the basic auth middleware structure

[SWITCH TO NAVIGATOR]

[NAVIGATOR: AI - 10 minutes]
/implement JWT token generation with refresh tokens
> AI generates secure token implementation

/test-gen
> AI creates comprehensive test suite

[SWITCH TO DRIVER]

[DRIVER: You - 10 minutes]
# You refine the implementation
/review --security
> AI performs security review, suggests improvements

/commit --message "feat: JWT authentication with refresh tokens"
✅ Truth Score: 0.98 - Committed successfully
```

---

## Example 2: Bug Fixing

Debugging a memory leak in Node.js.

**Session Setup:**
```bash
claude-flow pair --start \
  --mode navigator \
  --agent debugger-expert \
  --focus debug \
  --trace
```

**Session Flow:**
```
👥 Starting debugging session...

/status
> Analyzing application for memory issues...

/perf --profile
> Memory usage growing: 150MB → 450MB over 10 minutes

/find "new EventEmitter" --regex
> Found 3 instances of EventEmitter creation

/inspect eventEmitters --deep
> Discovering listeners not being removed

/suggest fix for memory leak
> AI suggests: "Add removeListener in cleanup functions"

/implement cleanup functions for all event emitters
> AI generates proper cleanup code

/test
> Memory stable at 150MB ✅

/commit --message "fix: memory leak in event emitters"
```

---

## Example 3: TDD Session

Building shopping cart with test-driven development.

**Session Setup:**
```bash
claude-flow pair --start \
  --mode tdd \
  --agent tdd-specialist \
  --test-first
```

**Session Flow:**
```
👥 TDD Session: Shopping Cart Feature

[RED PHASE]
/test-gen "add item to cart"
> AI writes failing test:
  ✗ should add item to cart
  ✗ should update quantity for existing item
  ✗ should calculate total price

[GREEN PHASE]
/implement minimal cart functionality
> You write just enough code to pass tests

/test
> Tests passing: 3/3 ✅

[REFACTOR PHASE]
/refactor --pattern repository
> AI refactors to repository pattern

/test
> Tests still passing: 3/3 ✅

[NEXT CYCLE]
/test-gen "remove item from cart"
> AI writes new failing tests...
```

---

## Example 4: Code Refactoring

Modernizing legacy code.

**Session Setup:**
```bash
claude-flow pair --start \
  --mode driver \
  --focus refactor \
  --verify \
  --threshold 0.98
```

**Session Flow:**
```
👥 Refactoring Session: Modernizing UserService

/analyze UserService.js
> AI identifies:
  - Callback hell (5 levels deep)
  - No error handling
  - Tight coupling
  - No tests

/suggest refactoring plan
> AI suggests:
  1. Convert callbacks to async/await
  2. Add error boundaries
  3. Extract dependencies
  4. Add unit tests

/test-gen --before-refactor
> AI generates tests for current behavior

/refactor callbacks to async/await
# You refactor with AI guidance

/test
> All tests passing ✅

/review --compare
> AI shows before/after comparison
> Code complexity: 35 → 12
> Truth score: 0.99 ✅

/commit --message "refactor: modernize UserService with async/await"
```

---

## Example 5: Performance Optimization

Optimizing slow React application.

**Session Setup:**
```bash
claude-flow pair --start \
  --mode switch \
  --agent performance-expert \
  --focus optimize \
  --profile
```

**Session Flow:**
```
👥 Performance Optimization Session

/perf --profile
> React DevTools Profiler Results:
  - ProductList: 450ms render
  - CartSummary: 200ms render
  - Unnecessary re-renders: 15

/suggest optimizations for ProductList
> AI suggests:
  1. Add React.memo
  2. Use useMemo for expensive calculations
  3. Implement virtualization for long lists

/implement React.memo and useMemo
# You implement with AI guidance

/perf --profile
> ProductList: 45ms render (90% improvement!) ✅

/implement virtualization with react-window
> AI implements virtual scrolling

/perf --profile
> ProductList: 12ms render (97% improvement!) ✅
> FPS: 60 stable ✅

/commit --message "perf: optimize ProductList with memoization and virtualization"
```

---

## Example 6: API Development

Building RESTful API with Express.

**Session Setup:**
```bash
claude-flow pair --start \
  --mode navigator \
  --agent backend-expert \
  --focus implement \
  --test
```

**Session Flow:**
```
👥 API Development Session

/design REST API for blog platform
> AI designs endpoints:
  POST   /api/posts
  GET    /api/posts
  GET    /api/posts/:id
  PUT    /api/posts/:id
  DELETE /api/posts/:id

/implement CRUD endpoints with validation
> AI implements with Express + Joi validation

/test-gen --integration
> AI generates integration tests

/security --api
> AI adds:
  - Rate limiting
  - Input sanitization
  - JWT authentication
  - CORS configuration

/document --openapi
> AI generates OpenAPI documentation

/test --integration
> All endpoints tested: 15/15 ✅
```

---

## Session Status Example

```
👥 Pair Programming Session
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Session ID: pair_1755021234567
Duration: 45 minutes
Status: Active

Partner: senior-dev
Current Role: DRIVER (you)
Mode: Switch (10m intervals)
Next Switch: in 3 minutes

📊 Metrics:
├── Truth Score: 0.982 ✅
├── Lines Changed: 234
├── Files Modified: 5
├── Tests Added: 12
├── Coverage: 87% ↑3%
└── Commits: 3

🎯 Focus: Implementation
📝 Current File: src/auth/login.js
```

---

## Session History Example

```
📚 Session History
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 2024-01-15 14:30 - 16:45 (2h 15m)
   Partner: expert-coder
   Focus: Refactoring
   Truth Score: 0.975
   Changes: +340 -125 lines

2. 2024-01-14 10:00 - 11:30 (1h 30m)
   Partner: tdd-specialist
   Focus: Testing
   Truth Score: 0.991
   Tests Added: 24

3. 2024-01-13 15:00 - 17:00 (2h)
   Partner: debugger-expert
   Focus: Bug Fixing
   Truth Score: 0.968
   Issues Fixed: 5
```

---

## Troubleshooting Common Session Issues

### Session Won't Start
- Check agent availability
- Verify configuration file syntax
- Ensure clean workspace
- Review log files

### Session Disconnected
- Use `--recover` to restore
- Check network connection
- Verify background processes
- Review auto-save files

### Poor Performance
- Reduce verification threshold
- Disable continuous testing
- Check system resources
- Use lighter AI model

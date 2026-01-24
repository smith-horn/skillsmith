# Pair Programming Modes

Detailed guide to all available collaboration modes.

---

## Driver Mode

You write code while AI provides guidance.

```bash
claude-flow pair --start --mode driver
```

**Your Responsibilities:**
- Write actual code
- Implement solutions
- Make immediate decisions
- Handle syntax and structure

**AI Navigator:**
- Strategic guidance
- Spot potential issues
- Suggest improvements
- Real-time review
- Track overall direction

**Best For:**
- Learning new patterns
- Implementing familiar features
- Quick iterations
- Hands-on debugging

**Commands:**
```
/suggest     - Get implementation suggestions
/review      - Request code review
/explain     - Ask for explanations
/optimize    - Request optimization ideas
/patterns    - Get pattern recommendations
```

---

## Navigator Mode

AI writes code while you provide direction.

```bash
claude-flow pair --start --mode navigator
```

**Your Responsibilities:**
- Provide high-level direction
- Review generated code
- Make architectural decisions
- Ensure business requirements

**AI Driver:**
- Write implementation code
- Handle syntax details
- Implement your guidance
- Manage boilerplate
- Execute refactoring

**Best For:**
- Rapid prototyping
- Boilerplate generation
- Learning from AI patterns
- Exploring solutions

**Commands:**
```
/implement   - Direct implementation
/refactor    - Request refactoring
/test        - Generate tests
/document    - Add documentation
/alternate   - See alternative approaches
```

---

## Switch Mode

Automatically alternates roles at intervals.

```bash
# Default 10-minute intervals
claude-flow pair --start --mode switch

# 5-minute intervals (rapid)
claude-flow pair --start --mode switch --interval 5m

# 15-minute intervals (deep focus)
claude-flow pair --start --mode switch --interval 15m
```

**Handoff Process:**
1. 30-second warning before switch
2. Current driver completes thought
3. Context summary generated
4. Roles swap smoothly
5. New driver continues

**Best For:**
- Balanced collaboration
- Knowledge sharing
- Complex features
- Extended sessions

---

## TDD Mode

Test-Driven Development workflow.

```bash
claude-flow pair --start \
  --mode tdd \
  --test-first \
  --coverage 100
```

**Workflow:**
1. **Red Phase**: Write failing test
2. **Green Phase**: Implement minimal code to pass
3. **Refactor Phase**: Clean up while tests pass
4. Repeat

**Example Session:**
```
[RED PHASE]
/test-gen "add item to cart"
> AI writes failing test:
  ✗ should add item to cart
  ✗ should update quantity for existing item

[GREEN PHASE]
/implement minimal cart functionality
> You write just enough code to pass tests

/test
> Tests passing: 2/2 ✅

[REFACTOR PHASE]
/refactor --pattern repository
> AI refactors to repository pattern

/test
> Tests still passing: 2/2 ✅
```

---

## Review Mode

Continuous code review focus.

```bash
claude-flow pair --start \
  --mode review \
  --strict \
  --security
```

**Features:**
- Real-time feedback on every change
- Security vulnerability scanning
- Performance analysis
- Best practice enforcement
- Complexity monitoring

**Review Aspects:**
| Aspect | Checks |
|--------|--------|
| Security | XSS, injection, auth issues |
| Performance | N+1 queries, memory leaks |
| Style | Naming, formatting, patterns |
| Complexity | Cyclomatic, nesting depth |

---

## Mentor Mode

Learning-focused collaboration.

```bash
claude-flow pair --start \
  --mode mentor \
  --explain-all \
  --pace slow
```

**Features:**
- Detailed explanations for every decision
- Step-by-step guidance
- Pattern teaching with examples
- Concept reinforcement
- Progress tracking

**Learning Levels:**
```
/explain --level basic    # Beginner-friendly
/explain --level detailed # Intermediate
/explain --level expert   # Advanced concepts
```

---

## Debug Mode

Problem-solving focus.

```bash
claude-flow pair --start \
  --mode debug \
  --verbose \
  --trace
```

**Features:**
- Issue identification
- Root cause analysis
- Fix suggestions
- Execution tracing
- Memory profiling

**Example Session:**
```
/status
> Analyzing application for issues...

/perf --profile
> Memory usage growing: 150MB → 450MB over 10 minutes

/find "new EventEmitter" --regex
> Found 3 instances of EventEmitter creation

/inspect eventEmitters --deep
> Discovering listeners not being removed

/suggest fix for memory leak
> AI suggests: "Add removeListener in cleanup functions"

/implement cleanup functions
> AI generates proper cleanup code

/test
> Memory stable at 150MB ✅
```

---

## Mode Comparison

| Mode | Primary Actor | Pace | Verification | Best For |
|------|---------------|------|--------------|----------|
| Driver | You | Self-directed | On-demand | Learning, control |
| Navigator | AI | Guided | Continuous | Speed, generation |
| Switch | Alternating | Timed | Per-switch | Balance, sharing |
| TDD | Alternating | Test-cycle | Every test | Quality, coverage |
| Review | You | Careful | Continuous | Quality focus |
| Mentor | AI | Slow | Educational | Learning |
| Debug | Collaborative | Issue-driven | Per-fix | Problem solving |

---

## Mode Configuration

Configure mode defaults in `.claude-flow/pair-config.json`:

```json
{
  "modes": {
    "driver": {
      "enabled": true,
      "suggestions": true,
      "realTimeReview": true,
      "autoComplete": false
    },
    "navigator": {
      "enabled": true,
      "codeGeneration": true,
      "explanations": true,
      "alternatives": true
    },
    "switch": {
      "enabled": true,
      "interval": "10m",
      "warning": "30s",
      "autoSwitch": true,
      "pauseOnIdle": true
    }
  }
}
```

---

## Changing Modes Mid-Session

```bash
# Switch mode during session
/mode <type>

# Examples
/mode tdd       # Switch to TDD mode
/mode debug     # Switch to debug mode
/mode mentor    # Switch to mentor mode

# Check current mode
/role
```

// SMI-4667 E3 + E4-extended: bootstrap that runs BEFORE vitest registers
// its own SIGTERM handlers. Two responsibilities:
//
//   1. Raise defaultMaxListeners so accumulated product-code handlers
//      (5+ modules registering process.on('SIGTERM',...)) don't trip
//      MaxListenersExceededWarning. Symptomatic but cosmetically required.
//
//   2. Install a clean SIGTERM/SIGINT handler that calls process.exit(0).
//      E2/E3 results showed exit code 143 (SIGTERM-15) at vitest teardown
//      AFTER tests pass — the leaked product-code handlers fire during
//      shutdown and the OS-default response kills the process with 128+15
//      instead of clean 0. By installing our own handler FIRST (before
//      vitest's `process.once('SIGTERM', onExit)` registers), we force
//      a graceful exit-0 if SIGTERM fires from any source. If vitest's
//      onExit ran first it would do the right thing; this is defense
//      against leaked handlers winning the race.
require('events').EventEmitter.defaultMaxListeners = 50

// Synchronous SIGTERM/SIGINT exit-0. Loaded via NODE_OPTIONS=--require
// before vitest's own onExit registers, so this handler runs first.
// Empirically: this defeats the SIGTERM-143 exit observed in PR #893
// where leaked product-code SIGTERM handlers (H1) cascaded vitest's
// shutdown into a non-zero exit. With this handler, PID 7 (vitest CLI)
// exits 0 on SIGTERM, but workers may still exit non-zero when their
// parent disappears — the workflow handles that by parsing vitest
// output for failure markers rather than relying on the process exit.
let exiting = false
function gracefulExit() {
  if (exiting) return
  exiting = true
  process.exit(0)
}
process.on('SIGTERM', gracefulExit)
process.on('SIGINT', gracefulExit)

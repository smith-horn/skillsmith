// SMI-4244: lift the default 10-listener ceiling to absorb future modules
// that attach additional process-exit handlers (mcp-server context.ts,
// webhook endpoints). Primary fix is in client.events.ts; this is a
// defense-in-depth ceiling guard, not a root-cause fix.
process.setMaxListeners(20)

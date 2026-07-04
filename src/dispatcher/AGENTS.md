# AGENTS.md - Dispatcher Boundary

This directory owns workflow dispatch and the plugin capability boundary.
Changes here must preserve the public import surface through `src/dispatcher.ts`,
which is a compatibility shim for existing callers.

## Scope

- Keep dispatcher orchestration in `index.ts` until a protected split is needed.
- When splitting, keep capability policy, lifecycle/timeout control, audit
  recording, and capability view/proxy code in separate modules with tests
  before moving behavior.
- Do not move GitHub, Cloudflare, OpenClaw, or other provider-specific behavior
  into this directory. Dispatcher code should depend on neutral event,
  workflow plugin, task provider, and runtime provider contracts.

## Capability Boundary Rules

- Every capability getter, `context.actions` method, `context.runtime` method,
  and `readSecret` path must pass through the dispatcher gate before reaching a
  provider or runtime implementation.
- `context.capabilities.dispatchAgent` is equivalent to runtime start. It must
  require `runtime:start`, use the same audit action, and receive the lifecycle
  signal.
- Timeout / abort closes the plugin side-effect window. After timeout / abort,
  do not continue action or provider side effects; deny and audit later calls
  instead.
- Audit recording failures must not turn an already successful action into a
  failed action. Treat audit as observability, not the source of truth for the
  action result.
- Never expose secrets, raw descriptor objects, raw provider/runtime internals,
  or internal reason values through plugin-visible results, audit entries, or
  fallback context.
- Preserve method this binding. Optional provider methods, prototype methods,
  non-enumerable helpers, and private receiver-sensitive methods must keep their
  intended receiver when wrapped.

## Tests

- Use focused plugin runtime tests for new dispatcher behavior.
- Add regression tests before changing capability gates, timeout / abort
  handling, audit semantics, secret redaction, descriptor wrapping, or method
  binding.
- Keep `scripts/validate-agents.test.mjs` updated when these scoped rules move
  or gain new hard requirements.

# Plan: Strengthen Typed WS RPC Boundaries in Runtime Server

## Summary
Replace loose payload casting in runtime RPC handlers with strict schema parsing and typed helper wrappers.

## Motivation
- `apps/t3/src/runtimeApiServer.ts` should avoid payload casts and parse all unknown input at the RPC boundary.
- Casts can hide contract breakages until runtime.

## Scope
- Runtime WebSocket RPC registration and method dispatch.
- Optional shared helper for method-level parse/dispatch registration.

## Proposed Changes
1. Add RPC helper utility (e.g. `apps/t3/src/rpcHelpers.ts`) to:
   - Parse payload(s) with Zod schemas
   - Standardize typed handler signatures
2. Refactor provider RPC handlers in `apps/t3/src/runtimeApiServer.ts` to use:
   - `providerSessionStartInputSchema.parse`
   - `providerSendTurnInputSchema.parse`
   - `providerInterruptTurnInputSchema.parse`
   - `providerStopSessionInputSchema.parse`
3. Apply same pattern to app/todo/agent/terminal/shell handlers where possible.
4. Add tests for parsing failure paths (invalid payloads).

## Risks
- Refactor can subtly change RPC error shape/messages.
- Helper abstraction should stay simple and not obscure control flow.

## Validation
- `bun run test`
- `bun run typecheck`
- Manual invalid payload check from websocket client/devtools to confirm fast failure.

## Done Criteria
- No runtime handler uses `payload as Parameters<...>`.
- All websocket RPC entrypoints parse unknown payloads at boundary.

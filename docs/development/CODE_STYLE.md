# Code Style

## TypeScript

Strict typing is a product quality tool, not an aesthetic preference.

Required compiler posture includes:

- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `noImplicitOverride`
- `noImplicitReturns`
- `noFallthroughCasesInSwitch`
- `noPropertyAccessFromIndexSignature`
- `useUnknownInCatchVariables`

## OO guidance

Use objects for:

- state
- lifecycle
- coordination
- encapsulated invariants
- resource ownership

Use functions for:

- deterministic parsing
- mapping
- validation
- normalization

Prefer composition over inheritance.

Avoid abstract base classes unless multiple concrete implementations demonstrably share invariant behavior.

## Error handling

Do not silently swallow synchronization errors.

Use typed error/result boundaries where recovery is expected.

A renderer error should degrade the rendering, not damage source.

## Asynchrony

- no floating promises
- cancellation/disposal where lifecycle matters
- queues/barriers must be explicit
- avoid sleeps as synchronization
- avoid fire-and-forget document mutations

## Comments

Comment invariants and non-obvious reasoning.

Do not narrate obvious syntax.

## Formatting

Prettier handles formatting. ESLint handles correctness/style rules that should affect code quality.

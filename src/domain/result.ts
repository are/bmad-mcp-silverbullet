import type { DomainError } from './error.ts';

/**
 * Discriminated-union return type for pure-function modules (AR11,
 * architecture.md:1110-1118). Pure functions return `Result<T, E>` for
 * expected failures; throws are reserved for invariant violations and
 * infrastructure errors (handler top-level catch converts those to
 * `infrastructure_error`). The error parameter `E` defaults to the
 * placeholder `DomainError` shape; modules with a tighter local error type
 * (e.g. `ConfigError` in story 1.4) parameterize it explicitly so callers
 * can narrow on rich fields without a type guard.
 */
export type Result<T, E extends DomainError = DomainError> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: E };

export const ok = <T, E extends DomainError = DomainError>(value: T): Result<T, E> => ({
  kind: 'ok',
  value,
});

export const err = <T, E extends DomainError = DomainError>(error: E): Result<T, E> => ({
  kind: 'error',
  error,
});

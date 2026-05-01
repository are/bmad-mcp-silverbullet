import type { DomainError } from './error.ts';

/**
 * Discriminated-union return type for pure-function modules (AR11,
 * architecture.md:1110-1118). Pure functions return `Result<T>` for expected
 * failures; throws are reserved for invariant violations and infrastructure
 * errors (handler top-level catch converts those to `infrastructure_error`).
 */
export type Result<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: DomainError };

export const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });

export const err = <T>(error: DomainError): Result<T> => ({ kind: 'error', error });

import type { Config } from './config.ts';

const REDACTED = '***redacted***';
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

type MaskedView = {
  silverbulletUrl: string;
  silverbulletToken: typeof REDACTED;
  auditLogPath?: string;
};

function maskedView(silverbulletUrl: string, auditLogPath: string | undefined): MaskedView {
  const out: MaskedView = {
    silverbulletUrl,
    silverbulletToken: REDACTED,
  };
  if (auditLogPath !== undefined) out.auditLogPath = auditLogPath;
  return out;
}

/**
 * Wraps a {@link Config} so that `JSON.stringify`, `String(...)`, template-
 * literal interpolation, and `util.inspect` all mask `silverbulletToken` as
 * `***redacted***` (AR40, NFR5).
 *
 * Direct property access still returns the live token — the SilverBullet
 * client needs it to send the `Authorization: Bearer <token>` header. The
 * implementation defends against three exposure paths:
 *
 * 1. `JSON.stringify(wrapped)` — handled by the `toJSON` hook returning the
 *    masked view.
 * 2. `String(wrapped)` / template literals / `util.inspect(wrapped)` — handled
 *    by `toString` and the inspect-custom hook.
 * 3. Spread bypass `JSON.stringify({ ...wrapped })` — handled by making
 *    `silverbulletToken` a **non-enumerable getter** so spread / `Object.keys`
 *    / `for...in` simply don't see it. The getter still serves direct access.
 *
 * The serializer hooks (`toJSON`, `toString`, `[util.inspect.custom]`) are
 * also non-enumerable, so they don't appear in `Object.keys` either.
 *
 * `auditLogPath` is omitted from the JSON projection when undefined; rendered
 * as the literal string `undefined` in `toString` for stable log shape.
 */
/**
 * Surface returned by {@link wrapConfig}. Extends {@link Config} with the
 * serializer hooks so call sites can `String(cfg)` and pass `cfg` to logs
 * without tripping `@typescript-eslint/no-base-to-string`. The hooks remain
 * non-enumerable at runtime so they don't appear in `Object.keys` / spread.
 */
export type WrappedConfig = Config & {
  toString(): string;
  toJSON(): unknown;
};

export function wrapConfig(raw: Config): WrappedConfig {
  // Construct a base object whose ENUMERABLE own properties are only the
  // non-secret fields. The token is added below as a non-enumerable getter.
  const base: Omit<Config, 'silverbulletToken'> =
    raw.auditLogPath !== undefined
      ? { silverbulletUrl: raw.silverbulletUrl, auditLogPath: raw.auditLogPath }
      : { silverbulletUrl: raw.silverbulletUrl };

  const liveToken = raw.silverbulletToken;

  Object.defineProperties(base, {
    silverbulletToken: {
      get(): string {
        return liveToken;
      },
      enumerable: false,
      configurable: false,
    },
    toJSON: {
      value(): MaskedView {
        return maskedView(raw.silverbulletUrl, raw.auditLogPath);
      },
      enumerable: false,
      writable: false,
      configurable: false,
    },
    toString: {
      value(): string {
        const path = raw.auditLogPath ?? 'undefined';
        return `Config(silverbulletUrl=${raw.silverbulletUrl}, silverbulletToken=${REDACTED}, auditLogPath=${path})`;
      },
      enumerable: false,
      writable: false,
      configurable: false,
    },
    [INSPECT_CUSTOM]: {
      value(): MaskedView {
        return maskedView(raw.silverbulletUrl, raw.auditLogPath);
      },
      enumerable: false,
      writable: false,
      configurable: false,
    },
  });

  // Boundary cast: after defineProperties installs the silverbulletToken
  // getter and the three serializer hooks, `base` is structurally a
  // WrappedConfig. AR59 permits `as` at the wrapper's type boundary.
  return base as WrappedConfig;
}

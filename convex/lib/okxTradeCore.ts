// ============================================================
// OKX TRADING — pure pieces (no I/O): config/kill switches,
// request signing, and contract sizing. Unit-tested directly.
// ============================================================

export type TradingMode = "demo" | "live";
export type TradingAccess = "admins" | "all";
export type OkxCredentials = { key: string; secret: string; passphrase: string };
export type OkxAccount = { mode: TradingMode; credentials: OkxCredentials; personal?: true };

export interface TradingConfig {
  /** Null when trading is off (no keys, or OKX_TRADING_MODE unset/invalid). */
  mode: TradingMode | null;
  access: TradingAccess;
  /** Max notional per order, USD. */
  maxOrderUsd: number;
  /** Max open notional per user across all live positions, USD. */
  maxUserNotionalUsd: number;
  /** Platform cap on user leverage (also capped by the instrument's max). */
  maxLeverage: number;
  credentials: OkxCredentials | null;
}

const positive = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Read trading settings. Safe by default: anything missing or unrecognised
 * turns trading OFF rather than guessing. Live requires OKX_TRADING_MODE=live
 * spelled exactly.
 */
export function readTradingConfig(env: Record<string, string | undefined>): TradingConfig {
  const key = env.OKX_API_KEY?.trim();
  const secret = env.OKX_API_SECRET?.trim();
  const passphrase = env.OKX_API_PASSPHRASE?.trim();
  const credentials = key && secret && passphrase ? { key, secret, passphrase } : null;
  const rawMode = env.OKX_TRADING_MODE?.trim();
  const mode: TradingMode | null = !credentials ? null : rawMode === "live" ? "live" : rawMode === "demo" ? "demo" : null;
  return {
    mode,
    access: env.OKX_TRADING_ACCESS?.trim() === "all" ? "all" : "admins",
    maxOrderUsd: positive(env.OKX_MAX_ORDER_USD, 500),
    maxUserNotionalUsd: positive(env.OKX_MAX_USER_NOTIONAL_USD, 2_000),
    maxLeverage: Math.floor(positive(env.OKX_MAX_LEVERAGE, 10)),
    credentials,
  };
}

// ─── signing ─────────────────────────────────────────────────

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** OKX v5: base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath + body)). */
export async function signOkx(secret: string, timestamp: string, method: string, requestPath: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(timestamp + method.toUpperCase() + requestPath + body));
  return toBase64(sig);
}

// ─── sizing (exact decimal math on lot multiples) ───────────

function decimals(step: string): number {
  const s = step.trim();
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** "0.01" → { units: 1n, scale: 2 } so sizes are integers of 10^-scale. */
function toUnits(value: string, scale: number): bigint {
  const [whole, frac = ""] = value.trim().split(".");
  return BigInt(whole || "0") * 10n ** BigInt(scale) + BigInt((frac + "0".repeat(scale)).slice(0, scale) || "0");
}

function fromUnits(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const s = units.toString().padStart(scale + 1, "0");
  const out = `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}

export interface ContractSpec {
  /** Base units per contract (stock perps: 1 share; BTC: 0.01 BTC). */
  ctVal: number;
  lotSz: string;
  minSz: string;
}

/**
 * Contracts (as OKX's `sz` string) for a target notional, rounded DOWN to a
 * whole number of lots so we never spend more than asked. Null when the result
 * is below the instrument's minimum order size.
 */
export function contractsForNotional(notionalUsd: number, price: number, spec: ContractSpec): string | null {
  if (!(notionalUsd > 0) || !(price > 0) || !(spec.ctVal > 0)) return null;
  const scale = Math.max(decimals(spec.lotSz), decimals(spec.minSz));
  const lot = toUnits(spec.lotSz, scale);
  const min = toUnits(spec.minSz, scale);
  if (lot <= 0n) return null;
  const raw = notionalUsd / (price * spec.ctVal); // contracts, float
  const rawUnits = BigInt(Math.floor(raw * 10 ** scale + 1e-9));
  const units = (rawUnits / lot) * lot;
  if (units < min || units <= 0n) return null;
  return fromUnits(units, scale);
}

/** Exact `a - b` on OKX size strings (never negative). */
export function subtractSz(a: string, b: string): string {
  const scale = Math.max(decimals(a), decimals(b));
  const diff = toUnits(a, scale) - toUnits(b, scale);
  return fromUnits(diff > 0n ? diff : 0n, scale);
}

/** OKX client order id: 1–32 alphanumerics, unique per account. */
export function clientOrderId(prefix: "o" | "c" | "l", seed: string): string {
  return (prefix + seed.replace(/[^a-zA-Z0-9]/g, "")).slice(0, 32);
}

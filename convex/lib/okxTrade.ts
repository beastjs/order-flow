// ============================================================
// OKX TRADING — signed REST calls for the platform account.
// Actions only (mutations cannot fetch). Demo mode adds the
// `x-simulated-trading: 1` header, which routes every call to
// OKX's demo-trading environment with simulated funds.
// ============================================================

import { readTradingConfig, signOkx, type TradingConfig } from "./okxTradeCore";

const REST = "https://www.okx.com";

export class OkxApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Per-order status code (sCode) when OKX rejects an order. */
    readonly sCode?: string,
  ) {
    super(message);
  }
}

/** OKX code for "order does not exist" (used to detect never-placed orders). */
export const ORDER_NOT_FOUND = "51603";

export function tradingConfig(): TradingConfig {
  return readTradingConfig(process.env);
}

function requireCredentials(cfg: TradingConfig) {
  if (!cfg.mode || !cfg.credentials) throw new Error("Real-order trading is not enabled.");
  return { mode: cfg.mode, ...cfg.credentials };
}

async function privateCall<T>(method: "GET" | "POST", path: string, body?: object): Promise<T[]> {
  const { mode, key, secret, passphrase } = requireCredentials(tradingConfig());
  const payload = body ? JSON.stringify(body) : "";
  const timestamp = new Date().toISOString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": key,
    "OK-ACCESS-SIGN": await signOkx(secret, timestamp, method, path, payload),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": passphrase,
  };
  if (mode === "demo") headers["x-simulated-trading"] = "1";

  const res = await fetch(`${REST}${path}`, { method, headers, body: payload || undefined });
  let json: { code?: string; msg?: string; data?: Array<T & { sCode?: string; sMsg?: string }> };
  try {
    json = await res.json();
  } catch {
    throw new OkxApiError(`OKX ${path.split("?")[0]} → HTTP ${res.status}`, String(res.status));
  }
  if (json.code !== "0") {
    // Order endpoints put the real reason in data[0].sCode / sMsg.
    const first = json.data?.[0];
    const reason = first?.sMsg || json.msg || "unknown error";
    throw new OkxApiError(`OKX ${json.code}${first?.sCode ? `/${first.sCode}` : ""}: ${reason}`, json.code ?? "?", first?.sCode);
  }
  return json.data ?? [];
}

/** Orders need long/short (hedge) mode so users' longs and shorts don't net out. */
export async function ensureLongShortMode(): Promise<void> {
  const [cfg] = await privateCall<{ posMode: string }>("GET", "/api/v5/account/config");
  if (cfg?.posMode === "long_short_mode") return;
  await privateCall("POST", "/api/v5/account/set-position-mode", { posMode: "long_short_mode" });
}

/** Exchange-side leverage for the whole platform account on this instrument (cross margin). */
export async function setLeverage(instId: string, lever: number): Promise<void> {
  await privateCall("POST", "/api/v5/account/set-leverage", { instId, lever: String(lever), mgnMode: "cross" });
}

export interface PlaceOrderArgs {
  instId: string;
  side: "buy" | "sell";
  posSide: "long" | "short";
  sz: string;
  clOrdId: string;
  reduceOnly?: boolean;
}

/** Market order. Idempotent per clOrdId: OKX rejects a duplicate clOrdId, it never fills twice. */
export async function placeMarketOrder(a: PlaceOrderArgs): Promise<{ ordId: string }> {
  const [row] = await privateCall<{ ordId: string }>("POST", "/api/v5/trade/order", {
    instId: a.instId,
    tdMode: "cross",
    side: a.side,
    posSide: a.posSide,
    ordType: "market",
    sz: a.sz,
    clOrdId: a.clOrdId,
    ...(a.reduceOnly ? { reduceOnly: true } : {}),
  });
  if (!row?.ordId) throw new OkxApiError("OKX accepted the order without an order id.", "?");
  return { ordId: row.ordId };
}

export interface OkxOrderState {
  ordId: string;
  /** live | partially_filled | filled | canceled | mmp_canceled */
  state: string;
  avgPx: number;
  /** Filled contracts, exactly as OKX reports them (e.g. "2.82"). */
  accFillSz: string;
  /** Fee in USDT; OKX reports charges as negative numbers. */
  fee: number;
}

/** Look an order up by client id. Null when OKX has no such order (it was never placed). */
export async function getOrder(instId: string, clOrdId: string): Promise<OkxOrderState | null> {
  try {
    const [o] = await privateCall<Record<string, string>>(
      "GET",
      `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&clOrdId=${encodeURIComponent(clOrdId)}`,
    );
    if (!o) return null;
    return {
      ordId: o.ordId,
      state: o.state,
      avgPx: Number(o.avgPx) || 0,
      accFillSz: /^\d+(\.\d+)?$/.test(o.accFillSz ?? "") ? o.accFillSz : "0",
      fee: Number(o.fee) || 0,
    };
  } catch (e) {
    if (e instanceof OkxApiError && (e.code === ORDER_NOT_FOUND || e.sCode === ORDER_NOT_FOUND)) return null;
    throw e;
  }
}

/** Terminal states: nothing more will fill. */
export const isFinalState = (state: string) => state === "filled" || state === "canceled" || state === "mmp_canceled";

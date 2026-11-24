// ============================================================
// OKX TRADING — signed REST calls for platform and personal accounts.
// Actions only (mutations cannot fetch). Demo mode adds the
// `x-simulated-trading: 1` header, which routes every call to
// OKX's demo-trading environment with simulated funds.
// ============================================================

import { readTradingConfig, signOkx, type OkxAccount, type TradingConfig } from "./okxTradeCore";

const REST = "https://www.okx.com";
const PERSONAL_REST = "https://openapi.okx.com";

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

export function platformAccount(cfg: TradingConfig): OkxAccount {
  if (!cfg.mode || !cfg.credentials) throw new Error("Real-order trading is not enabled.");
  return { mode: cfg.mode, credentials: cfg.credentials };
}

async function privateCall<T>(account: OkxAccount, method: "GET" | "POST", path: string, body?: object, submitBy?: number): Promise<T[]> {
  const { mode, credentials: { key, secret, passphrase } } = account;
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
  if (submitBy !== undefined) headers.expTime = String(submitBy);

  const res = await fetch(`${account.personal ? PERSONAL_REST : REST}${path}`, {
    method, headers, body: payload || undefined, redirect: "error",
  });
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
  if (!Array.isArray(json.data)) throw new OkxApiError("OKX returned an invalid response.", "?");
  return json.data;
}

export async function getAccountConfig(account: OkxAccount) {
  const [config] = await privateCall<{ uid: string; perm: string; posMode: string; acctLv: string }>(account, "GET", "/api/v5/account/config");
  return config;
}

export async function getAvailableUsdt(account: OkxAccount): Promise<number> {
  const [balance] = await privateCall<{ details: { ccy: string; availBal: string }[] }>(account, "GET", "/api/v5/account/balance?ccy=USDT");
  if (!balance) return 0;
  if (!Array.isArray(balance?.details)) throw new Error("OKX balance is unavailable.");
  const available = Number(balance.details.find((row) => row.ccy === "USDT")?.availBal ?? 0);
  if (!Number.isFinite(available)) throw new Error("OKX balance is unavailable.");
  return Math.max(0, available);
}

export async function getIsolatedPositionSize(account: OkxAccount, instId: string, posSide: "long" | "short"): Promise<number> {
  const rows = await privateCall<{ instId: string; posSide: string; mgnMode: string; pos: string }>(
    account, "GET", `/api/v5/account/positions?instId=${encodeURIComponent(instId)}`,
  );
  const position = rows.find((row) => row.instId === instId && row.posSide === posSide && row.mgnMode === "isolated");
  const size = position ? Number(position.pos) : 0;
  if (!Number.isFinite(size) || size < 0) throw new Error("OKX position size is unavailable.");
  return size;
}

/** Orders need long/short (hedge) mode so users' longs and shorts don't net out. */
export async function ensureLongShortMode(account: OkxAccount): Promise<void> {
  const cfg = await getAccountConfig(account);
  if (cfg?.posMode === "long_short_mode") return;
  if (account.personal) throw new Error("Switch your OKX account to Long/short mode first.");
  await privateCall(account, "POST", "/api/v5/account/set-position-mode", { posMode: "long_short_mode" });
}

export async function setLeverage(account: OkxAccount, instId: string, lever: number, posSide: "long" | "short"): Promise<void> {
  await privateCall(account, "POST", "/api/v5/account/set-leverage", {
    instId, lever: String(lever), mgnMode: account.personal ? "isolated" : "cross",
    ...(account.personal ? { posSide } : {}),
  });
}

export interface PlaceOrderArgs {
  instId: string;
  side: "buy" | "sell";
  posSide: "long" | "short";
  sz: string;
  clOrdId: string;
  reduceOnly?: boolean;
  submitBy: number;
}

export async function placeMarketOrder(account: OkxAccount, a: PlaceOrderArgs): Promise<{ ordId: string }> {
  const [row] = await privateCall<{ ordId: string; sCode?: string; sMsg?: string }>(account, "POST", "/api/v5/trade/order", {
    instId: a.instId,
    tdMode: account.personal ? "isolated" : "cross",
    side: a.side,
    posSide: a.posSide,
    ordType: "market",
    sz: a.sz,
    clOrdId: a.clOrdId,
    // Long/short SWAP orders close the specified side implicitly on OKX.
    ...(a.reduceOnly && !account.personal ? { reduceOnly: true } : {}),
  }, a.submitBy);
  if (row?.sCode && row.sCode !== "0") throw new OkxApiError(`OKX ${row.sCode}: ${row.sMsg ?? "Order rejected"}`, "1", row.sCode);
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
export async function getOrder(account: OkxAccount, instId: string, clOrdId: string): Promise<OkxOrderState | null> {
  try {
    const [o] = await privateCall<Record<string, string>>(
      account, "GET",
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

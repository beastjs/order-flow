// Server-side OKX REST reads (actions only — mutations cannot fetch).

const REST = "https://www.okx.com";

async function get<T>(path: string): Promise<T[]> {
  const res = await fetch(`${REST}${path}`);
  if (!res.ok) throw new Error(`OKX ${path.split("?")[0]} → HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: T[] };
  if (body.code !== "0" || !Array.isArray(body.data)) throw new Error(`OKX error ${body.code}: ${body.msg ?? "unknown"}`);
  return body.data;
}

const num = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("OKX returned an invalid price.");
  return n;
};

const CATEGORY: Record<string, "crypto" | "stock" | "commodity"> = { "1": "crypto", "3": "stock", "4": "commodity" };

export interface OkxSwap {
  instId: string;
  base: string;
  category: "crypto" | "stock" | "commodity" | "other";
  maxLeverage: number;
}

/** A live USDT-margined perpetual, or throw. */
export async function fetchSwap(instId: string): Promise<OkxSwap> {
  if (!/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(instId)) throw new Error("Unsupported instrument.");
  const [row] = await get<Record<string, string>>(
    `/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`,
  );
  if (!row || row.state !== "live" || row.settleCcy !== "USDT") throw new Error(`${instId} is not tradable.`);
  return {
    instId,
    base: row.ctValCcy || instId.split("-")[0],
    category: CATEGORY[row.instCategory] ?? "other",
    maxLeverage: Number(row.lever) || 1,
  };
}

/** Best bid/ask: market orders buy at the ask and sell at the bid. */
export async function fetchQuote(instId: string): Promise<{ bid: number; ask: number }> {
  const [t] = await get<Record<string, string>>(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
  if (!t) throw new Error(`No quote for ${instId}.`);
  return { bid: num(t.bidPx), ask: num(t.askPx) };
}

/** Mark prices for every SWAP in one call (used by the liquidation sweep). */
export async function fetchAllMarks(): Promise<Map<string, number>> {
  const rows = await get<Record<string, string>>("/api/v5/public/mark-price?instType=SWAP");
  const marks = new Map<string, number>();
  for (const r of rows) {
    const px = Number(r.markPx);
    if (r.instId && Number.isFinite(px) && px > 0) marks.set(r.instId, px);
  }
  return marks;
}

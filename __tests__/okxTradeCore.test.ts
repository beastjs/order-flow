import { createHmac } from "node:crypto";
import { clientOrderId, contractsForNotional, readTradingConfig, signOkx } from "../convex/lib/okxTradeCore";

const KEYS = { OKX_API_KEY: "k", OKX_API_SECRET: "s", OKX_API_PASSPHRASE: "p" };

describe("trading config (kill switches)", () => {
  it("is OFF without credentials even if a mode is set", () => {
    expect(readTradingConfig({ OKX_TRADING_MODE: "live" }).mode).toBeNull();
  });

  it("is OFF with credentials but no or unknown mode", () => {
    expect(readTradingConfig({ ...KEYS }).mode).toBeNull();
    expect(readTradingConfig({ ...KEYS, OKX_TRADING_MODE: "LIVE" }).mode).toBeNull();
    expect(readTradingConfig({ ...KEYS, OKX_TRADING_MODE: "production" }).mode).toBeNull();
  });

  it("demo and live only when spelled exactly; access defaults to admins", () => {
    expect(readTradingConfig({ ...KEYS, OKX_TRADING_MODE: "demo" })).toMatchObject({ mode: "demo", access: "admins" });
    expect(readTradingConfig({ ...KEYS, OKX_TRADING_MODE: "live", OKX_TRADING_ACCESS: "all" })).toMatchObject({ mode: "live", access: "all" });
  });

  it("uses conservative default limits and ignores junk overrides", () => {
    expect(readTradingConfig({ ...KEYS, OKX_TRADING_MODE: "demo" })).toMatchObject({ maxOrderUsd: 500, maxUserNotionalUsd: 2000, maxLeverage: 10 });
    expect(readTradingConfig({ ...KEYS, OKX_TRADING_MODE: "demo", OKX_MAX_ORDER_USD: "-5", OKX_MAX_LEVERAGE: "abc" })).toMatchObject({ maxOrderUsd: 500, maxLeverage: 10 });
  });
});

describe("signing", () => {
  it("matches HMAC-SHA256/base64 over timestamp+METHOD+path+body (OKX v5)", async () => {
    const ts = "2026-11-18T10:00:00.000Z";
    const path = "/api/v5/trade/order";
    const body = JSON.stringify({ instId: "AAPL-USDT-SWAP", sz: "1" });
    const expected = createHmac("sha256", "secret").update(ts + "POST" + path + body).digest("base64");
    expect(await signOkx("secret", ts, "post", path, body)).toBe(expected);
    const getExpected = createHmac("sha256", "secret").update(ts + "GET" + "/api/v5/account/config").digest("base64");
    expect(await signOkx("secret", ts, "GET", "/api/v5/account/config", "")).toBe(getExpected);
  });
});

describe("contract sizing", () => {
  const STOCK = { ctVal: 1, lotSz: "0.01", minSz: "0.01" }; // AAPL-USDT-SWAP
  const BTC = { ctVal: 0.01, lotSz: "0.01", minSz: "0.01" }; // BTC-USDT-SWAP
  const WHOLE = { ctVal: 10, lotSz: "1", minSz: "1" };

  it("rounds down to whole lots (never spends more than asked)", () => {
    expect(contractsForNotional(1000, 353.36, STOCK)).toBe("2.82"); // 2.8299… → 2.82
    expect(contractsForNotional(1000, 64_000, BTC)).toBe("1.56"); // 1.5625 contracts
    expect(contractsForNotional(1000, 3, WHOLE)).toBe("33");
  });

  it("returns null below the minimum size", () => {
    expect(contractsForNotional(1, 353.36, STOCK)).toBeNull();
    expect(contractsForNotional(5, 64_000, BTC)).toBeNull();
    expect(contractsForNotional(0, 100, STOCK)).toBeNull();
  });

  it("handles float edge cases exactly", () => {
    expect(contractsForNotional(30, 1, { ctVal: 0.1, lotSz: "0.1", minSz: "0.1" })).toBe("300");
    expect(contractsForNotional(0.3, 1, { ctVal: 1, lotSz: "0.1", minSz: "0.1" })).toBe("0.3");
  });
});

it("client order ids are alphanumeric and ≤ 32 chars", () => {
  const id = clientOrderId("o", "jh70atm81rfy4cksv8gmh24m458jd2hb_extra-stuff");
  expect(id).toMatch(/^[a-zA-Z0-9]{1,32}$/);
  expect(id.startsWith("o")).toBe(true);
});

describe("subtractSz", () => {
  it("is exact on decimal strings and floors at zero", async () => {
    const { subtractSz } = await import("../convex/lib/okxTradeCore");
    expect(subtractSz("2.82", "1.5")).toBe("1.32");
    expect(subtractSz("0.3", "0.1")).toBe("0.2"); // float would give 0.19999…
    expect(subtractSz("33", "33")).toBe("0");
    expect(subtractSz("1", "2")).toBe("0");
  });
});

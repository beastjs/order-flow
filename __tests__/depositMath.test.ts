// ─── Top-up money math + deposit config integrity ─────────────────
// Exhaustive / property checks on the conversions that decide how much
// is sent and credited, and sanity checks on the hand-maintained chain
// table (a typo there sends real money to the wrong contract).
import { describe, expect, it } from "bun:test";
import { getAddress, isAddress } from "viem";
import {
  DEPOSIT_CHAINS,
  MIN_TOPUP_USD,
  PUBLIC_RPC,
  depositChain,
  isWholeCents,
  linkWalletMessage,
  nativeUnitsToUsd,
  unitsToUsd,
  usdToNativeUnits,
  usdToUnits,
} from "@/lib/deposits/config";

const cents = (c: number) => Number((c / 100).toFixed(2)); // what a user types, as JS parses it

describe("isWholeCents (Top up amount validator)", () => {
  it("accepts every whole-cent amount from $0 to $10,000 (float-safe)", () => {
    const rejected: number[] = [];
    for (let c = 0; c <= 1_000_000; c++) if (!isWholeCents(cents(c))) rejected.push(cents(c));
    expect(rejected).toEqual([]); // the old `Math.round(v*100) === v*100` rejected 32.02, 32.05, …
  });

  it("rejects sub-cent amounts and non-numbers", () => {
    for (const v of [25.001, 25.005, 0.009, 1e-7, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isWholeCents(v)).toBe(false);
    }
  });

  it("the minimum is itself a valid amount", () => {
    expect(isWholeCents(MIN_TOPUP_USD)).toBe(true);
  });
});

describe("stablecoin units", () => {
  it("usdToUnits is exact (cents × 10⁴) and round-trips through unitsToUsd", () => {
    for (let c = 0; c <= 200_000; c += 7) {
      const usd = cents(c);
      expect(usdToUnits(usd)).toBe(BigInt(c) * 10_000n);
      expect(unitsToUsd(usdToUnits(usd))).toBe(usd);
    }
  });

  it("handles large balances without float drift", () => {
    expect(usdToUnits(9_999_999.99)).toBe(9_999_999_990_000n);
    expect(unitsToUsd(9_999_999_990_000n)).toBe(9_999_999.99);
  });
});

describe("native coin conversion", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Chainlink answers carry exactly 8 decimals; $0.001 … $100,000 per coin.
  const feedPrice = () => Math.max(1e-8, Number((10 ** (rand() * 8 - 3)).toFixed(8)));

  it("sending usdToNativeUnits(x) always credits at least x, and at most one cent more", () => {
    for (let i = 0; i < 20_000; i++) {
      const price = feedPrice();
      const usd = cents(2500 + Math.floor(rand() * 1_000_000));
      const credited = nativeUnitsToUsd(usdToNativeUnits(usd, price), price);
      expect(credited).toBeGreaterThanOrEqual(usd);
      expect(credited - usd).toBeLessThanOrEqual(0.0100001);
    }
  });

  it("credits round down to the cent and never exceed the exact value", () => {
    for (let i = 0; i < 20_000; i++) {
      const price = feedPrice();
      const wei = BigInt(Math.floor(rand() * 1e9)) * 10n ** 12n;
      const exact = (Number(wei) / 1e18) * price;
      const credited = nativeUnitsToUsd(wei, price);
      expect(credited).toBeLessThanOrEqual(exact + 1e-9);
      expect(exact - credited).toBeLessThan(0.0100001);
      expect(isWholeCents(credited)).toBe(true);
    }
  });

  it("zero coins credit zero", () => {
    expect(nativeUnitsToUsd(0n, 2000)).toBe(0);
  });
});

describe("deposit chain table", () => {
  it("every address is a valid, checksummed EVM address", () => {
    for (const c of DEPOSIT_CHAINS) {
      for (const a of [...c.tokens.map((t) => t.address), c.native.priceFeed]) {
        expect(isAddress(a)).toBe(true);
        expect(getAddress(a)).toBe(a);
      }
    }
  });

  it("chains are unique, have a public RPC, positive confirmations and distinct token contracts", () => {
    const ids = DEPOSIT_CHAINS.map((c) => c.chainId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of DEPOSIT_CHAINS) {
      expect(PUBLIC_RPC[c.chainId]).toMatch(/^https:\/\//);
      expect(c.confirmations).toBeGreaterThan(0);
      expect(new Set(c.tokens.map((t) => t.symbol)).size).toBe(c.tokens.length);
      expect(new Set(c.tokens.map((t) => t.address.toLowerCase())).size).toBe(c.tokens.length);
      expect(c.native.maxPriceAgeSec).toBeGreaterThan(0);
      expect(depositChain(c.chainId)).toBe(c);
    }
    expect(depositChain(56)).toBeUndefined();
  });

  it("only Sepolia is a testnet, and mainnet USDC/USDT are the canonical contracts", () => {
    expect(DEPOSIT_CHAINS.filter((c) => c.testnet).map((c) => c.chainId)).toEqual([11155111]);
    const eth = depositChain(1)!;
    expect(eth.tokens).toEqual([
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    ]);
  });
});

describe("linkWalletMessage", () => {
  it("binds wallet, account and time, so a signature can't be reused for another account", () => {
    const a = linkWalletMessage("acct_1", "0xAbC", "2026-01-01T00:00:00.000Z");
    expect(a).toContain("Wallet: 0xAbC");
    expect(a).toContain("Account: acct_1");
    expect(a).toContain("Issued at: 2026-01-01T00:00:00.000Z");
    expect(linkWalletMessage("acct_2", "0xAbC", "2026-01-01T00:00:00.000Z")).not.toBe(a);
    expect(linkWalletMessage("acct_1", "0xAbC", "2026-01-01T00:00:00.000Z")).toBe(a); // deterministic
  });
});

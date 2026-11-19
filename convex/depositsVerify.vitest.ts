/// <reference types="vite/client" />
// ─── Top-up verification, end to end, against a scripted chain ────────
// `deposits.verify` is the only code that decides whether real USD gets
// credited. The chain client is mocked so every branch (unmined, reverted,
// wrong token, unlinked sender, confirmations, native price lock, stale
// price, RPC failure, retry budget, disabled config) runs deterministically.
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionReceiptNotFoundError, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Log } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEPOSIT_CHAINS, linkWalletMessage, usdToUnits } from "../src/lib/deposits/config";
import { matchDeposit } from "./lib/depositMatch";

// ─── scripted chain ─────────────────────────────────────────────

type Receipt = { status: "success" | "reverted"; blockNumber: bigint; logs: Log[] } | null;
const chain = {
  receipt: null as Receipt | Error,
  head: 0n,
  tx: { from: "0x0", to: null as string | null, value: 0n },
  price: 2000 as number | Error,
  priceReads: 0,
};

vi.mock("./lib/chain", () => ({
  chainClient: () => ({
    getTransactionReceipt: async () => {
      if (chain.receipt instanceof Error) throw chain.receipt;
      if (!chain.receipt) throw new TransactionReceiptNotFoundError({ hash: "0x00" });
      return chain.receipt;
    },
    getBlockNumber: async () => chain.head,
    getTransaction: async () => chain.tx,
    verifyMessage: async () => false,
  }),
  readNativePrice: async () => {
    chain.priceReads++;
    if (chain.price instanceof Error) throw chain.price;
    return chain.price;
  },
}));

const modules = import.meta.glob("./**/*.ts");
const DEST = getAddress("0x000000000000000000000000000000000000bEEF");
const ETH = DEPOSIT_CHAINS.find((c) => c.chainId === 1)!;
const USDC = ETH.tokens.find((t) => t.symbol === "USDC")!.address;
const USDT = ETH.tokens.find((t) => t.symbol === "USDT")!.address;
const ALICE = { subject: "alice", tokenIdentifier: "firebase|alice", email: "alice@example.test" };
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const page = { paginationOpts: { numItems: 10, cursor: null } };

/** A real ERC-20 Transfer log, as viem would return it in a receipt. */
function transferLog(token: string, from: string, to: string, value: bigint, logIndex = 0): Log {
  return {
    address: token as `0x${string}`,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: from as `0x${string}`, to: to as `0x${string}` } }) as Log["topics"],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockNumber: 100n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"22".repeat(32)}`,
    transactionIndex: 0,
    logIndex,
    removed: false,
  } as Log;
}

beforeEach(() => {
  process.env.DEPOSIT_DESTINATION_ADDRESS = DEST;
  delete process.env.DEPOSIT_ALLOW_TESTNET;
  Object.assign(chain, { receipt: null, head: 0n, tx: { from: "0x0", to: null, value: 0n }, price: 2000, priceReads: 0 });
});

async function linkedUser() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);
  const userId = await alice.mutation(api.users.store, {});
  const account = privateKeyToAccount(generatePrivateKey());
  const issuedAt = new Date().toISOString();
  const signature = await account.signMessage({ message: linkWalletMessage(userId, account.address, issuedAt) });
  await alice.action(api.deposits.linkWallet, { address: account.address, issuedAt, signature });
  return { t, alice, wallet: account.address };
}

async function submitAndVerify(ctx: Awaited<ReturnType<typeof linkedUser>>, n: number, chainId = 1) {
  const depositId = await ctx.alice.mutation(api.deposits.submit, { chainId, txHash: hash(n) });
  await ctx.t.action(internal.deposits.verify, { depositId });
  return depositId;
}

async function row(ctx: Awaited<ReturnType<typeof linkedUser>>, id: Id<"deposits">) {
  return (await ctx.alice.query(api.deposits.listMine, page)).page.find((d) => d._id === id)!;
}

// ─── state machine ───────────────────────────────────────────────

describe("deposits.verify", () => {
  it("waits (pending, attempt counted) while the transaction isn't mined", async () => {
    const ctx = await linkedUser();
    const id = await submitAndVerify(ctx, 1);
    expect(await row(ctx, id)).toMatchObject({ status: "pending", attempts: 1, reason: "Waiting for the transaction to be mined." });
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(0);
  });

  it("rejects a reverted transaction", async () => {
    const ctx = await linkedUser();
    chain.receipt = { status: "reverted", blockNumber: 100n, logs: [] };
    const id = await submitAndVerify(ctx, 2);
    expect(await row(ctx, id)).toMatchObject({ status: "rejected", reason: "The transaction reverted on-chain." });
  });

  it("credits an allow-listed stablecoin transfer only after enough confirmations", async () => {
    const ctx = await linkedUser();
    chain.receipt = { status: "success", blockNumber: 100n, logs: [transferLog(USDC, ctx.wallet, DEST, usdToUnits(42.5))] };
    chain.head = 102n; // 3 of 6
    const id = await submitAndVerify(ctx, 3);
    expect(await row(ctx, id)).toMatchObject({ status: "pending", confirmations: 3, blockNumber: 100 });
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(0);

    chain.head = 105n; // 6 of 6
    await ctx.t.action(internal.deposits.verify, { depositId: id });
    expect(await row(ctx, id)).toMatchObject({ status: "credited", token: "USDC", amountUsd: 42.5, confirmations: 6 });
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(42.5);

    // Re-running verify after the credit is a no-op.
    await ctx.t.action(internal.deposits.verify, { depositId: id });
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(42.5);
  });

  it("rejects a transfer from a wallet that isn't linked to the account", async () => {
    const ctx = await linkedUser();
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    chain.receipt = { status: "success", blockNumber: 100n, logs: [transferLog(USDC, stranger, DEST, usdToUnits(100))] };
    chain.head = 200n;
    const id = await submitAndVerify(ctx, 4);
    expect(await row(ctx, id)).toMatchObject({ status: "rejected", reason: "Sent from a wallet that isn't linked to your account." });
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(0);
  });

  it("rejects a look-alike token contract and a transfer to some other address", async () => {
    const ctx = await linkedUser();
    const fakeToken = "0x000000000000000000000000000000000000dEaD";
    chain.receipt = {
      status: "success",
      blockNumber: 100n,
      logs: [
        transferLog(fakeToken, ctx.wallet, DEST, usdToUnits(1000), 0),
        transferLog(USDC, ctx.wallet, "0x0000000000000000000000000000000000000001", usdToUnits(1000), 1),
      ],
    };
    chain.head = 200n;
    const id = await submitAndVerify(ctx, 5);
    expect(await row(ctx, id)).toMatchObject({ status: "rejected" });
    expect((await row(ctx, id)).reason).toMatch(/No USDC\/USDT\/ETH transfer/);
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(0);
  });

  it("holds an under-minimum transfer for review instead of crediting it", async () => {
    const ctx = await linkedUser();
    chain.receipt = { status: "success", blockNumber: 100n, logs: [transferLog(USDT, ctx.wallet, DEST, usdToUnits(24.99))] };
    chain.head = 200n;
    const id = await submitAndVerify(ctx, 6);
    expect(await row(ctx, id)).toMatchObject({ status: "under_minimum", amountUsd: 24.99 });
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(0);
  });

  it("credits native ETH at the price locked when the mined tx was first seen", async () => {
    const ctx = await linkedUser();
    chain.receipt = { status: "success", blockNumber: 100n, logs: [] };
    chain.tx = { from: ctx.wallet, to: DEST, value: 25_000_000_000_000_000n }; // 0.025 ETH
    chain.price = 2000;
    chain.head = 101n; // 2 of 6 → price locks now
    const id = await submitAndVerify(ctx, 7);
    expect(await row(ctx, id)).toMatchObject({ status: "pending", priceUsd: 2000 });

    chain.price = 1000; // market halves before confirmations finish
    chain.head = 110n;
    await ctx.t.action(internal.deposits.verify, { depositId: id });
    expect(await row(ctx, id)).toMatchObject({ status: "credited", token: "ETH", priceUsd: 2000, amountUsd: 50 });
    expect(chain.priceReads).toBe(1); // the locked price is reused, not re-read
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(50);
  });

  it("does not credit native coins while the price feed is stale; it retries", async () => {
    const ctx = await linkedUser();
    chain.receipt = { status: "success", blockNumber: 100n, logs: [] };
    chain.tx = { from: ctx.wallet, to: DEST, value: 10n ** 18n };
    chain.price = new Error("ETH/USD price is stale (300 min old).");
    chain.head = 200n;
    const id = await submitAndVerify(ctx, 8);
    const r = await row(ctx, id);
    expect(r.status).toBe("pending");
    expect(r.reason).toMatch(/stale/);
    expect(r.priceUsd).toBeUndefined();
    expect(await ctx.alice.query(api.funds.usd, {})).toBe(0);
  });

  it("rejects a native transfer from an unlinked wallet and a zero-value one", async () => {
    const ctx = await linkedUser();
    chain.receipt = { status: "success", blockNumber: 100n, logs: [] };
    chain.head = 200n;
    chain.tx = { from: privateKeyToAccount(generatePrivateKey()).address, to: DEST, value: 10n ** 18n };
    expect(await row(ctx, await submitAndVerify(ctx, 9))).toMatchObject({ status: "rejected", reason: "Sent from a wallet that isn't linked to your account." });
    chain.tx = { from: ctx.wallet, to: DEST, value: 0n };
    expect(await row(ctx, await submitAndVerify(ctx, 10))).toMatchObject({ status: "rejected" });
    expect(chain.priceReads).toBe(0);
  });

  it("treats an RPC failure as transient (retry, no credit, no rejection)", async () => {
    const ctx = await linkedUser();
    chain.receipt = new Error("fetch failed: ECONNRESET\nstack…");
    const id = await submitAndVerify(ctx, 11);
    expect(await row(ctx, id)).toMatchObject({ status: "pending", attempts: 1, reason: "RPC error: fetch failed: ECONNRESET" });
  });

  it("fails a deposit when top-ups are switched off after it was submitted", async () => {
    const ctx = await linkedUser();
    const id = await ctx.alice.mutation(api.deposits.submit, { chainId: 1, txHash: hash(12) });
    delete process.env.DEPOSIT_DESTINATION_ADDRESS;
    await ctx.t.action(internal.deposits.verify, { depositId: id });
    expect(await row(ctx, id)).toMatchObject({ status: "failed", reason: "Top-ups are disabled on this network." });
  });

  it("gives up after the retry budget instead of polling forever", async () => {
    const ctx = await linkedUser();
    const id = await ctx.alice.mutation(api.deposits.submit, { chainId: 1, txHash: hash(13) });
    for (let i = 0; i < 149; i++) await ctx.t.mutation(internal.deposits.retry, { depositId: id, note: "still waiting" });
    expect((await row(ctx, id)).status).toBe("pending");
    await ctx.t.mutation(internal.deposits.retry, { depositId: id, note: "still waiting" });
    expect(await row(ctx, id)).toMatchObject({ status: "failed", attempts: 150 });
    expect((await row(ctx, id)).reason).toMatch(/^Timed out/);
  });
});

// ─── submit guards ───────────────────────────────────────────────

describe("deposits.submit", () => {
  it("refuses signed-out callers and hashes in any shape but 32 bytes of hex", async () => {
    const ctx = await linkedUser();
    await expect(ctx.t.mutation(api.deposits.submit, { chainId: 1, txHash: hash(1) })).rejects.toThrow(/Not signed in/);
    for (const bad of ["", "0x", hash(1).slice(0, 65), `${hash(1)}00`, hash(1).replace("0x", "0X0"), `0x${"g".repeat(64)}`]) {
      await expect(ctx.alice.mutation(api.deposits.submit, { chainId: 1, txHash: bad })).rejects.toThrow(/Invalid transaction hash/);
    }
    await expect(ctx.alice.mutation(api.deposits.submit, { chainId: 56, txHash: hash(1) })).rejects.toThrow(/not supported/);
  });
});

// ─── pure matcher ────────────────────────────────────────────────

describe("matchDeposit", () => {
  const me = getAddress("0x1111111111111111111111111111111111111111");

  it("sums several transfers of the same token and ignores everything else", () => {
    const logs = [
      transferLog(USDC, me, DEST, usdToUnits(10), 0),
      transferLog(USDC, me, DEST, usdToUnits(15.5), 1),
      transferLog(USDC, me, me, usdToUnits(999), 2), // not to the deposit address
    ];
    expect(matchDeposit(logs, ETH, DEST, [me])).toMatchObject({ kind: "ok", token: "USDC", units: usdToUnits(25.5) });
  });

  it("never mixes tokens: a USDC + USDT tx credits only the first token's total", () => {
    const logs = [transferLog(USDT, me, DEST, usdToUnits(30), 0), transferLog(USDC, me, DEST, usdToUnits(70), 1)];
    expect(matchDeposit(logs, ETH, DEST, [me])).toMatchObject({ kind: "ok", token: "USDT", units: usdToUnits(30) });
  });

  it("matches addresses case-insensitively", () => {
    const logs = [transferLog(USDC, me, DEST, usdToUnits(50))];
    expect(matchDeposit(logs, ETH, DEST.toLowerCase() as `0x${string}`, [me.toLowerCase()]).kind).toBe("ok");
  });

  it("ignores logs that aren't ERC-20 Transfers", () => {
    const junk = { ...transferLog(USDC, me, DEST, 1n), topics: [`0x${"ab".repeat(32)}`] } as unknown as Log;
    expect(matchDeposit([junk], ETH, DEST, [me])).toEqual({ kind: "none" });
  });
});

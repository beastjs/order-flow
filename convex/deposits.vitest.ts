/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DEPOSIT_CHAINS, linkWalletMessage, nativeUnitsToUsd, usdToNativeUnits, usdToUnits } from "../src/lib/deposits/config";
import { matchNativeDeposit } from "./lib/depositMatch";

const modules = import.meta.glob("./**/*.ts");
const DEST = "0x000000000000000000000000000000000000bEEF";
const ALICE = { subject: "alice", tokenIdentifier: "firebase|alice", email: "alice@example.test" };
const BOB = { subject: "bob", tokenIdentifier: "firebase|bob", email: "bob@example.test" };
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

beforeEach(() => {
  process.env.DEPOSIT_DESTINATION_ADDRESS = DEST;
  delete process.env.DEPOSIT_ALLOW_TESTNET;
});

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);
  const bob = t.withIdentity(BOB);
  const aliceId = await alice.mutation(api.users.store, {});
  await bob.mutation(api.users.store, {});
  return { t, alice, bob, aliceId };
}

async function signLink(accountId: string, key = generatePrivateKey(), issuedAt = new Date().toISOString()) {
  const wallet = privateKeyToAccount(key);
  const signature = await wallet.signMessage({ message: linkWalletMessage(accountId, wallet.address, issuedAt) });
  return { address: wallet.address, issuedAt, signature };
}

describe("config", () => {
  it("is null without a deposit address, and hides testnets unless allowed", async () => {
    const t = convexTest(schema, modules);
    delete process.env.DEPOSIT_DESTINATION_ADDRESS;
    expect(await t.query(api.deposits.config, {})).toBeNull();

    process.env.DEPOSIT_DESTINATION_ADDRESS = DEST;
    const cfg = await t.query(api.deposits.config, {});
    expect(cfg).toMatchObject({ address: DEST, minUsd: 25 });
    expect(cfg!.chains.map((c) => c.chainId)).toEqual([1, 42161, 137]);

    process.env.DEPOSIT_ALLOW_TESTNET = "true";
    expect((await t.query(api.deposits.config, {}))!.chains.map((c) => c.chainId)).toContain(11155111);
  });

  it("offers each network's native coin, and USDT on Sepolia", async () => {
    process.env.DEPOSIT_ALLOW_TESTNET = "true";
    const chains = (await convexTest(schema, modules).query(api.deposits.config, {}))!.chains;
    expect(Object.fromEntries(chains.map((c) => [c.chainId, c.native.symbol]))).toEqual({ 1: "ETH", 42161: "ETH", 137: "POL", 11155111: "ETH" });
    expect(chains.find((c) => c.chainId === 11155111)!.tokens.map((t) => t.symbol)).toEqual(["USDC", "USDT"]);
  });
});

describe("wallet linking (real signatures)", () => {
  it("links a wallet whose owner signed the message for this account", async () => {
    const { alice, aliceId } = await setup();
    const link = await signLink(aliceId);
    expect(await alice.action(api.deposits.linkWallet, link)).toBe(link.address);
    expect(await alice.query(api.deposits.myWallets, {})).toEqual([link.address]);
  });

  it("rejects a signature made for a different account (no replay across users)", async () => {
    const { bob, aliceId } = await setup();
    const link = await signLink(aliceId); // signed for Alice's account id
    await expect(bob.action(api.deposits.linkWallet, link)).rejects.toThrow(/does not match/);
  });

  it("rejects a forged address, an expired signature, and a wallet owned by someone else", async () => {
    const { t, alice, bob, aliceId } = await setup();
    const link = await signLink(aliceId);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await expect(alice.action(api.deposits.linkWallet, { ...link, address: other })).rejects.toThrow(/does not match/);

    const stale = await signLink(aliceId, generatePrivateKey(), new Date(Date.now() - 11 * 60_000).toISOString());
    await expect(alice.action(api.deposits.linkWallet, stale)).rejects.toThrow(/expired/);

    const key = generatePrivateKey();
    await alice.action(api.deposits.linkWallet, await signLink(aliceId, key));
    const bobId = (await bob.query(api.users.me, {}))!._id;
    await expect(bob.action(api.deposits.linkWallet, await signLink(bobId, key))).rejects.toThrow(/another account/);
    void t;
  });
});

describe("submit + settle", () => {
  async function linked() {
    const ctx = await setup();
    const link = await signLink(ctx.aliceId);
    await ctx.alice.action(api.deposits.linkWallet, link);
    return { ...ctx, wallet: link.address };
  }

  it("requires a linked wallet, a valid hash and a supported network", async () => {
    const { alice } = await setup();
    await expect(alice.mutation(api.deposits.submit, { chainId: 1, txHash: hash(1) })).rejects.toThrow(/Link a wallet/);
    const { alice: a2 } = await linked();
    await expect(a2.mutation(api.deposits.submit, { chainId: 1, txHash: "0x123" })).rejects.toThrow(/Invalid transaction/);
    await expect(a2.mutation(api.deposits.submit, { chainId: 11155111, txHash: hash(2) })).rejects.toThrow(/not supported/);
  });

  it("dedupes a tx per chain: same user gets the same row, another user is refused", async () => {
    const { t, alice } = await linked();
    const id = await alice.mutation(api.deposits.submit, { chainId: 1, txHash: hash(7) });
    expect(await alice.mutation(api.deposits.submit, { chainId: 1, txHash: hash(7).toUpperCase().replace("0X", "0x") })).toBe(id);

    const bob = t.withIdentity(BOB);
    const bobId = (await bob.query(api.users.me, {}))!._id;
    await bob.action(api.deposits.linkWallet, await signLink(bobId));
    await expect(bob.mutation(api.deposits.submit, { chainId: 1, txHash: hash(7) })).rejects.toThrow(/already submitted/);
  });

  it("credits the USD balance exactly once and leaves paper funds alone", async () => {
    const { alice, wallet } = await linked();
    const id = await alice.mutation(api.deposits.submit, { chainId: 137, txHash: hash(9) });
    const paperBefore = (await alice.query(api.funds.mine, {}))!.balance;
    expect(await alice.query(api.funds.usd, {})).toBe(0);

    const settle = { depositId: id, token: "USDC" as const, from: wallet, amountUnits: usdToUnits(40).toString(), blockNumber: 100, confirmations: 40 };
    await alice.mutation(internal.deposits.settle, settle);
    await alice.mutation(internal.deposits.settle, settle); // replayed: must not double-credit

    expect(await alice.query(api.funds.usd, {})).toBe(40);
    expect((await alice.query(api.funds.mine, {}))!.balance).toBe(paperBefore);
    const [row] = (await alice.query(api.deposits.listMine, { paginationOpts: { numItems: 5, cursor: null } })).page;
    expect(row).toMatchObject({ status: "credited", amountUsd: 40, token: "USDC" });

    await alice.mutation(api.funds.resetPaper, {});
    expect(await alice.query(api.funds.usd, {})).toBe(40); // Reset never touches real funds
  });

  it("does not credit transfers under the $25 minimum", async () => {
    const { alice, wallet } = await linked();
    const id = await alice.mutation(api.deposits.submit, { chainId: 1, txHash: hash(11) });
    await alice.mutation(internal.deposits.settle, { depositId: id, token: "USDT", from: wallet, amountUnits: usdToUnits(24.99).toString(), blockNumber: 1, confirmations: 6 });
    expect(await alice.query(api.funds.usd, {})).toBe(0);
    const [row] = (await alice.query(api.deposits.listMine, { paginationOpts: { numItems: 5, cursor: null } })).page;
    expect(row.status).toBe("under_minimum");
  });

  it("credits native coins at the locked Chainlink price, rounded down to the cent", async () => {
    const { t, alice, wallet } = await linked();
    const id = await alice.mutation(api.deposits.submit, { chainId: 1, txHash: hash(21) });
    // First sighting locks $2000; a later (different) price must not replace it.
    await t.mutation(internal.deposits.retry, { depositId: id, note: "confirming", priceUsd: 2000 });
    await t.mutation(internal.deposits.retry, { depositId: id, note: "confirming", priceUsd: 1500 });
    const wei = 25_123_456_789_000_000n; // 0.025123456789 ETH × $2000 = $50.246…
    await t.mutation(internal.deposits.settle, { depositId: id, token: "ETH", from: wallet, amountUnits: wei.toString(), priceUsd: 1500, blockNumber: 5, confirmations: 6 });
    expect(await alice.query(api.funds.usd, {})).toBe(50.24);
    const [row] = (await alice.query(api.deposits.listMine, { paginationOpts: { numItems: 5, cursor: null } })).page;
    expect(row).toMatchObject({ status: "credited", token: "ETH", priceUsd: 2000, amountUsd: 50.24 });
  });

  it("refuses to credit a native deposit with no price", async () => {
    const { t, alice, wallet } = await linked();
    const id = await alice.mutation(api.deposits.submit, { chainId: 137, txHash: hash(22) });
    await expect(
      t.mutation(internal.deposits.settle, { depositId: id, token: "POL", from: wallet, amountUnits: (10n ** 21n).toString(), blockNumber: 5, confirmations: 40 }),
    ).rejects.toThrow(/no USD price/);
    expect(await alice.query(api.funds.usd, {})).toBe(0);
  });

  it("a rejected deposit can never be credited afterwards", async () => {
    const { alice, wallet } = await linked();
    const id = await alice.mutation(api.deposits.submit, { chainId: 1, txHash: hash(12) });
    await alice.mutation(internal.deposits.finish, { depositId: id, status: "rejected", reason: "test" });
    await alice.mutation(internal.deposits.settle, { depositId: id, token: "USDC", from: wallet, amountUnits: usdToUnits(100).toString(), blockNumber: 1, confirmations: 6 });
    expect(await alice.query(api.funds.usd, {})).toBe(0);
  });
});

describe("native matching + conversion", () => {
  const eth = DEPOSIT_CHAINS[0];
  const me = "0x1111111111111111111111111111111111111111";
  it("matches only a plain value transfer to the deposit address from a linked wallet", () => {
    expect(matchNativeDeposit({ from: me, to: DEST, value: 5n }, eth, DEST, [me])).toMatchObject({ kind: "ok", token: "ETH", units: 5n });
    expect(matchNativeDeposit({ from: me, to: DEST, value: 5n }, eth, DEST, [])).toEqual({ kind: "unlinked" });
    expect(matchNativeDeposit({ from: me, to: DEST, value: 0n }, eth, DEST, [me])).toEqual({ kind: "none" });
    expect(matchNativeDeposit({ from: me, to: me, value: 5n }, eth, DEST, [me])).toEqual({ kind: "none" });
    expect(matchNativeDeposit({ from: me, to: null, value: 5n }, eth, DEST, [me])).toEqual({ kind: "none" });
  });

  it("sends enough coin to reach the USD amount at the quoted price", () => {
    for (const price of [0.0806, 1762.35, 65_000]) {
      for (const usd of [25, 50, 99.99, 250]) expect(nativeUnitsToUsd(usdToNativeUnits(usd, price), price)).toBeGreaterThanOrEqual(usd);
    }
  });
});

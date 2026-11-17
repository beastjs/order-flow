import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { TransactionReceiptNotFoundError, getAddress, isAddress, verifyMessage, type Hex } from "viem";
import schema, { stableSymbol } from "./schema";
import { currentUser, requireUser } from "./lib/auth";
import { writeLog } from "./lib/log";
import { chainClient } from "./lib/chain";
import { matchDeposit } from "./lib/depositMatch";
import { creditUsd } from "./funds";
import {
  DEPOSIT_CHAINS,
  LINK_MESSAGE_TTL_MS,
  MIN_TOPUP_USD,
  depositChain,
  linkWalletMessage,
  unitsToUsd,
  type DepositChain,
} from "../src/lib/deposits/config";

const MAX_ATTEMPTS = 150;
const retryDelayMs = (attempt: number) => (attempt < 20 ? 10_000 : attempt < 60 ? 30_000 : 120_000);

/** DEPOSIT_DESTINATION_ADDRESS on this Convex deployment, or null (top-ups disabled). */
function destination(): `0x${string}` | null {
  const raw = process.env.DEPOSIT_DESTINATION_ADDRESS;
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

function enabledChain(chainId: number): DepositChain | undefined {
  const chain = depositChain(chainId);
  if (!chain) return undefined;
  if (chain.testnet && process.env.DEPOSIT_ALLOW_TESTNET !== "true") return undefined;
  return chain;
}

// ─── public reads ────────────────────────────────────────────

/** What the top-up UI needs. Null when this deployment has no deposit address. */
export const config = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      address: v.string(),
      minUsd: v.number(),
      chains: v.array(
        v.object({
          chainId: v.number(),
          name: v.string(),
          confirmations: v.number(),
          testnet: v.boolean(),
          tokens: v.array(v.object({ symbol: stableSymbol, address: v.string() })),
        }),
      ),
    }),
  ),
  handler: async () => {
    const address = destination();
    if (!address) return null;
    const chains = DEPOSIT_CHAINS.filter((c) => enabledChain(c.chainId)).map((c) => ({
      chainId: c.chainId,
      name: c.name,
      confirmations: c.confirmations,
      testnet: c.testnet,
      tokens: c.tokens.map((t) => ({ symbol: t.symbol, address: t.address as string })),
    }));
    return { address, minUsd: MIN_TOPUP_USD, chains };
  },
});

/** The caller's linked wallet addresses. */
export const myWallets = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("wallets")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(50);
    return rows.map((w) => w.address);
  },
});

/** The caller's top-ups, newest first. */
export const listMine = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("deposits")),
  handler: async (ctx, { paginationOpts }) => {
    const user = await currentUser(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("deposits")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .order("desc")
      .paginate(paginationOpts);
  },
});

// ─── wallet linking ──────────────────────────────────────────

export const whoami = internalQuery({
  args: {},
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx) => (await currentUser(ctx))?._id ?? null,
});

/**
 * Link a wallet by verifying a signature over `linkWalletMessage(account, address, issuedAt)`.
 * The server rebuilds the message with the caller's own account id, so a signature
 * can only ever link that wallet to the account that asked for it.
 */
export const linkWallet = action({
  args: { address: v.string(), issuedAt: v.string(), signature: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const userId: Id<"users"> | null = await ctx.runQuery(internal.deposits.whoami, {});
    if (!userId) throw new Error("Not signed in.");
    if (!isAddress(args.address)) throw new Error("Invalid wallet address.");
    if (!/^0x[0-9a-fA-F]+$/.test(args.signature)) throw new Error("Invalid signature.");
    const issued = Date.parse(args.issuedAt);
    if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > LINK_MESSAGE_TTL_MS) {
      throw new Error("Signature expired — please sign again.");
    }

    const address = getAddress(args.address);
    const message = linkWalletMessage(userId, address, args.issuedAt);
    const signature = args.signature as Hex;
    // Plain EOAs verify offline; smart-contract wallets (ERC-1271/6492) need a chain call.
    let valid = await verifyMessage({ address, message, signature }).catch(() => false);
    if (!valid) valid = await chainClient(1).verifyMessage({ address, message, signature }).catch(() => false);
    if (!valid) throw new Error("Signature does not match this wallet.");

    await ctx.runMutation(internal.deposits.saveWallet, { address });
    return address;
  },
});

export const saveWallet = internalMutation({
  args: { address: v.string() },
  returns: v.null(),
  handler: async (ctx, { address }) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db
      .query("wallets")
      .withIndex("by_address", (q) => q.eq("address", address))
      .unique();
    if (existing) {
      if (existing.userId !== user._id) throw new Error("This wallet is linked to another account.");
      return null;
    }
    await ctx.db.insert("wallets", { userId: user._id, address, linkedAt: Date.now() });
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "wallet_linked",
      message: `Linked wallet ${address.slice(0, 6)}…${address.slice(-4)}`,
    });
    await writeLog(ctx, "info", "deposits.linkWallet", "wallet linked", { userId: user._id, data: { address } });
    return null;
  },
});

// ─── submit + verify ─────────────────────────────────────────

/** Register a sent top-up transaction; verification runs in the background. */
export const submit = mutation({
  args: { chainId: v.number(), txHash: v.string() },
  returns: v.id("deposits"),
  handler: async (ctx, { chainId, txHash }) => {
    const user = await requireUser(ctx);
    if (!destination()) throw new Error("Top-ups are not enabled.");
    const chain = enabledChain(chainId);
    if (!chain) throw new Error("Top-ups are not supported on this network.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Invalid transaction hash.");
    const hash = txHash.toLowerCase();

    const linked = await ctx.db
      .query("wallets")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .first();
    if (!linked) throw new Error("Link a wallet before topping up.");

    const existing = await ctx.db
      .query("deposits")
      .withIndex("by_chainId_and_txHash", (q) => q.eq("chainId", chainId).eq("txHash", hash))
      .unique();
    if (existing) {
      if (existing.userId !== user._id) throw new Error("This transaction was already submitted.");
      return existing._id;
    }

    const depositId = await ctx.db.insert("deposits", {
      userId: user._id,
      chainId,
      txHash: hash,
      status: "pending",
      requiredConfirmations: chain.confirmations,
      attempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.deposits.verify, { depositId });
    return depositId;
  },
});

export const forVerify = internalQuery({
  args: { depositId: v.id("deposits") },
  returns: v.union(
    v.null(),
    v.object({
      chainId: v.number(),
      txHash: v.string(),
      status: schema.tables.deposits.validator.fields.status,
      required: v.number(),
      wallets: v.array(v.string()),
    }),
  ),
  handler: async (ctx, { depositId }) => {
    const d = await ctx.db.get("deposits", depositId);
    if (!d) return null;
    const wallets = await ctx.db
      .query("wallets")
      .withIndex("by_userId", (q) => q.eq("userId", d.userId))
      .take(50);
    return {
      chainId: d.chainId,
      txHash: d.txHash,
      status: d.status,
      required: d.requiredConfirmations,
      wallets: wallets.map((w) => w.address),
    };
  },
});

/** Read the receipt from the chain and decide: wait, reject, or credit. */
export const verify = internalAction({
  args: { depositId: v.id("deposits") },
  returns: v.null(),
  handler: async (ctx, { depositId }) => {
    const d = await ctx.runQuery(internal.deposits.forVerify, { depositId });
    if (!d || d.status !== "pending") return null;
    const chain = enabledChain(d.chainId);
    const dest = destination();
    if (!chain || !dest) {
      await ctx.runMutation(internal.deposits.finish, { depositId, status: "failed", reason: "Top-ups are disabled on this network." });
      return null;
    }

    try {
      const client = chainClient(d.chainId);
      const receipt = await client
        .getTransactionReceipt({ hash: d.txHash as Hex })
        .catch((e: unknown) => {
          if (e instanceof TransactionReceiptNotFoundError) return null;
          throw e;
        });
      if (!receipt) {
        await ctx.runMutation(internal.deposits.retry, { depositId, note: "Waiting for the transaction to be mined." });
        return null;
      }
      if (receipt.status !== "success") {
        await ctx.runMutation(internal.deposits.finish, { depositId, status: "rejected", reason: "The transaction reverted on-chain." });
        return null;
      }

      const match = matchDeposit(receipt.logs, chain, dest, d.wallets);
      if (match.kind !== "ok") {
        await ctx.runMutation(internal.deposits.finish, {
          depositId,
          status: "rejected",
          reason:
            match.kind === "unlinked"
              ? "Sent from a wallet that isn't linked to your account."
              : "No USDC/USDT transfer to the deposit address in this transaction.",
        });
        return null;
      }

      const head = await client.getBlockNumber();
      const confirmations = Number(head - receipt.blockNumber + 1n);
      const blockNumber = Number(receipt.blockNumber);
      if (confirmations < d.required) {
        await ctx.runMutation(internal.deposits.retry, {
          depositId,
          note: `Waiting for confirmations (${Math.max(0, confirmations)}/${d.required}).`,
          confirmations: Math.max(0, confirmations),
          blockNumber,
        });
        return null;
      }

      await ctx.runMutation(internal.deposits.settle, {
        depositId,
        token: match.token,
        from: match.from,
        amountUnits: match.units.toString(),
        blockNumber,
        confirmations,
      });
    } catch (e) {
      await ctx.runMutation(internal.deposits.retry, {
        depositId,
        note: `RPC error: ${e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e)}`,
      });
    }
    return null;
  },
});

/** Count an attempt and schedule the next check, or give up after MAX_ATTEMPTS. */
export const retry = internalMutation({
  args: {
    depositId: v.id("deposits"),
    note: v.string(),
    confirmations: v.optional(v.number()),
    blockNumber: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { depositId, note, confirmations, blockNumber }) => {
    const d = await ctx.db.get("deposits", depositId);
    if (!d || d.status !== "pending") return null;
    const attempts = d.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch("deposits", depositId, { attempts, status: "failed", reason: `Timed out. Last check: ${note}` });
      await writeLog(ctx, "error", "deposits.verify", "deposit verification timed out", {
        userId: d.userId,
        data: { depositId, chainId: d.chainId, txHash: d.txHash, note },
      });
      return null;
    }
    await ctx.db.patch("deposits", depositId, { attempts, reason: note, confirmations, blockNumber });
    await ctx.scheduler.runAfter(retryDelayMs(attempts), internal.deposits.verify, { depositId });
    return null;
  },
});

export const finish = internalMutation({
  args: {
    depositId: v.id("deposits"),
    status: v.union(v.literal("rejected"), v.literal("failed")),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { depositId, status, reason }) => {
    const d = await ctx.db.get("deposits", depositId);
    if (!d || d.status !== "pending") return null;
    await ctx.db.patch("deposits", depositId, { status, reason });
    await writeLog(ctx, "warn", "deposits.verify", `deposit ${status}`, {
      userId: d.userId,
      data: { depositId, chainId: d.chainId, txHash: d.txHash, reason },
    });
    return null;
  },
});

/** Credit a verified transfer exactly once (the pending check runs inside this transaction). */
export const settle = internalMutation({
  args: {
    depositId: v.id("deposits"),
    token: stableSymbol,
    from: v.string(),
    amountUnits: v.string(),
    blockNumber: v.number(),
    confirmations: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const d = await ctx.db.get("deposits", args.depositId);
    if (!d || d.status !== "pending") return null;
    const amountUsd = unitsToUsd(BigInt(args.amountUnits));
    const base = {
      token: args.token,
      from: args.from,
      amountUnits: args.amountUnits,
      amountUsd,
      blockNumber: args.blockNumber,
      confirmations: args.confirmations,
    };

    if (amountUsd < MIN_TOPUP_USD) {
      await ctx.db.patch("deposits", d._id, {
        ...base,
        status: "under_minimum",
        reason: `Below the $${MIN_TOPUP_USD} minimum — held for manual review, not credited.`,
      });
      await writeLog(ctx, "warn", "deposits.settle", "deposit below minimum (manual review)", {
        userId: d.userId,
        data: { depositId: d._id, chainId: d.chainId, txHash: d.txHash, amountUsd },
      });
      return null;
    }

    const balanceAfter = await creditUsd(ctx, d.userId, amountUsd);
    await ctx.db.patch("deposits", d._id, { ...base, status: "credited", reason: undefined, creditedAt: Date.now() });
    await ctx.db.insert("activity", {
      userId: d.userId,
      kind: "deposit_credited",
      message: `Top-up of $${amountUsd.toFixed(2)} in ${args.token} credited`,
      amount: amountUsd,
      balanceAfter,
    });
    await writeLog(ctx, "info", "deposits.settle", "deposit credited", {
      userId: d.userId,
      data: { depositId: d._id, chainId: d.chainId, txHash: d.txHash, amountUsd },
    });
    return null;
  },
});

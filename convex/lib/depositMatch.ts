import { erc20Abi, getAddress, isAddressEqual, parseEventLogs, type Log } from "viem";
import type { DepositChain, NativeSymbol, StableSymbol } from "../../src/lib/deposits/config";

export type MatchResult =
  | { kind: "none" }
  | { kind: "unlinked" }
  | { kind: "ok"; token: StableSymbol; from: string; units: bigint };

/**
 * From a receipt's logs, find allow-listed stablecoin Transfers to `dest`
 * sent by one of `wallets`. Pure: no I/O, so it's testable against real receipts.
 */
export function matchDeposit(
  logs: readonly Log[],
  chain: Pick<DepositChain, "tokens">,
  dest: `0x${string}`,
  wallets: readonly string[],
): MatchResult {
  const toDest = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: logs as Log[] }).filter(
    (l) => chain.tokens.some((t) => isAddressEqual(t.address, l.address)) && isAddressEqual(l.args.to, dest),
  );
  if (toDest.length === 0) return { kind: "none" };
  const mine = toDest.filter((l) => wallets.some((w) => isAddressEqual(w as `0x${string}`, l.args.from)));
  if (mine.length === 0) return { kind: "unlinked" };
  const token = chain.tokens.find((t) => isAddressEqual(t.address, mine[0].address))!.symbol;
  // Only sum the token of the first match so a mixed tx can't be mislabeled.
  const units = mine
    .filter((l) => isAddressEqual(l.address, mine[0].address))
    .reduce((sum, l) => sum + l.args.value, 0n);
  return { kind: "ok", token, from: getAddress(mine[0].args.from), units };
}

export type NativeMatchResult =
  | { kind: "none" }
  | { kind: "unlinked" }
  | { kind: "ok"; token: NativeSymbol; from: string; units: bigint };

/**
 * A plain native-coin transfer: the transaction itself sends `value` to `dest`
 * from one of `wallets`. Transfers made inside a contract call (e.g. from a
 * smart-contract wallet) leave no top-level value to `dest` and don't match.
 */
export function matchNativeDeposit(
  tx: { from: string; to: string | null; value: bigint },
  chain: Pick<DepositChain, "native">,
  dest: `0x${string}`,
  wallets: readonly string[],
): NativeMatchResult {
  if (!tx.to || tx.value <= 0n || !isAddressEqual(tx.to as `0x${string}`, dest)) return { kind: "none" };
  if (!wallets.some((w) => isAddressEqual(w as `0x${string}`, tx.from as `0x${string}`))) return { kind: "unlinked" };
  return { kind: "ok", token: chain.native.symbol, from: getAddress(tx.from), units: tx.value };
}

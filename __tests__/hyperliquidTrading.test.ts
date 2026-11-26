import { expect, it, spyOn } from "bun:test";
import { createWalletClient, custom } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { authorizeHlTrading, checkHlOrder, hasPendingHlOrder, hlIocLimit, reviewHlOrder, submitHlOrder } from "@/lib/hyperliquid/trading";

it("rounds IOC price limits toward the quoted price at Hyperliquid ticks", () => {
  expect(hlIocLimit(1234.5, true, 3)).toBe("1240.6");
  expect(hlIocLimit(1234.5, false, 3)).toBe("1228.4");
  expect(hlIocLimit(123456.0, true, 5)).toBe("124073");
  expect(hlIocLimit(0.001, false, 3)).toBe("0.001");
});

it("authorizes an agent, submits the reviewed builder order, and reconciles a timed-out reduce-only close", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    account: owner.address,
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_accounts") return [owner.address];
        if (method === "eth_chainId") return "0xa4b1";
        if (method === "eth_signTypedData_v4" && Array.isArray(params)) return await owner.signTypedData(JSON.parse(params[1]));
        throw new Error(`Unexpected RPC method ${method}`);
      },
    }),
  });
  const coin = "xyz:XYZ100";
  const actions: Record<string, unknown>[] = [];
  let size = "";
  let timedOut = false;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith("/exchange")) {
      actions.push(body.action);
      if (body.action.type === "approveAgent") return Response.json({ status: "ok", response: { type: "default" } });
      if (timedOut) throw new Error("Connection lost");
      return Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 4, avgPx: "101", totalSz: "0.5" } }] } } });
    }
    switch (body.type) {
      case "perpDexs": return Response.json([null, { name: "abc" }, { name: "xyz" }]);
      case "meta": return Response.json({ universe: [{ name: "xyz:OTHER" }, { name: coin, szDecimals: 2 }] });
      case "l2Book": return Response.json({ coin, time: Date.now(), levels: [[{ px: "100" }], [{ px: "101" }]] });
      case "clearinghouseState": return Response.json({ assetPositions: size ? [{ position: { coin, szi: size } }] : [] });
      case "activeAssetData": return Response.json({ leverage: { type: "isolated", value: 10 }, maxTradeSzs: ["2", "2"] });
      case "orderStatus": return Response.json({ status: "order", order: { status: "filled", order: { oid: 5 } } });
      default: throw new Error(`Unexpected info type ${body.type}`);
    }
  });
  try {
    await authorizeHlTrading(owner.address, wallet);
    expect(actions[0]).toMatchObject({ type: "approveAgent", hyperliquidChain: "Mainnet", agentName: "CFX Trading" });
    const open = await reviewHlOrder(owner.address, coin, { buy: true, notional: 102 });
    expect(open).toMatchObject({ asset: 120001, buy: true, size: "1", limit: "101.5", reduceOnly: false });
    await expect(submitHlOrder(open, async () => false)).rejects.toThrow(/wallet changed/);
    expect(actions).toHaveLength(1);
    await expect(submitHlOrder(open, async () => true)).resolves.toMatchObject({ totalSz: "0.5" });
    expect(actions[1]).toMatchObject({ orders: [{ a: 120001, b: true, s: "1", p: "101.5", r: false, t: { limit: { tif: "Ioc" } } }] });

    size = "0.50";
    timedOut = true;
    const close = await reviewHlOrder(owner.address, coin, { close: true });
    expect(close).toMatchObject({ buy: false, size: "0.5", limit: "99.5", reduceOnly: true });
    await expect(submitHlOrder(close, async () => true)).rejects.toThrow(/did not confirm/);
    expect(actions[2]).toMatchObject({ orders: [{ a: 120001, b: false, s: "0.5", p: "99.5", r: true }] });
    expect(hasPendingHlOrder(owner.address, coin)).toBe(true);
    await expect(submitHlOrder(close, async () => true)).rejects.toThrow(/previous order/);
    expect(actions).toHaveLength(3);
    await expect(checkHlOrder(owner.address, coin)).resolves.toContain("#5");
    expect(hasPendingHlOrder(owner.address, coin)).toBe(false);
  } finally {
    fetchMock.mockRestore();
  }
});

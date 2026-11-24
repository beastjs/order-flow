import {
  MAINT_MARGIN,
  STARTING_BALANCE,
  TAKER_FEE,
  closePosition,
  isLiquidated,
  liquidationPrice,
  metrics,
  openPosition,
  paperStore,
} from "@/lib/paper/paper";

describe("paper position math", () => {
  it("sizes a leveraged position from margin", () => {
    const p = openPosition("AAPL-USDT-SWAP", "up", 100, 10, 200);
    expect(p.size).toBeCloseTo(5); // $1,000 notional / $200
    expect(p.openFee).toBeCloseTo(1000 * TAKER_FEE);
  });

  it("long gains when price rises, short gains when it falls", () => {
    const long = openPosition("X", "up", 100, 10, 200);
    const short = openPosition("X", "down", 100, 10, 200);
    expect(metrics(long, 210).pnl).toBeCloseTo(50);
    expect(metrics(short, 210).pnl).toBeCloseTo(-50);
    expect(metrics(short, 190).pnl).toBeCloseTo(50);
  });

  it("puts liquidation where equity meets maintenance margin", () => {
    for (const side of ["up", "down"] as const) {
      const p = openPosition("X", side, 100, 20, 200);
      const liq = liquidationPrice(p);
      const equity = p.margin - p.openFee + (side === "up" ? 1 : -1) * (liq - p.entry) * p.size;
      expect(equity).toBeCloseTo(p.size * liq * MAINT_MARGIN, 6);
      expect(side === "up" ? liq < 200 : liq > 200).toBe(true);
      expect(isLiquidated(p, side === "up" ? liq - 0.01 : liq + 0.01)).toBe(true);
      expect(isLiquidated(p, 200)).toBe(false);
    }
  });

  it("1× long is effectively never liquidated", () => {
    expect(liquidationPrice(openPosition("X", "up", 100, 1, 200))).toBeLessThan(2);
  });

  it("caps a liquidation loss at margin plus the opening fee", () => {
    const p = openPosition("X", "up", 100, 50, 200);
    expect(closePosition(p, 150, true).realized).toBeCloseTo(-(100 + 5000 * TAKER_FEE));
  });
});

describe("paper store", () => {
  beforeEach(() => paperStore.reset());

  it("checks total targets against the full basket at market after fees", () => {
    paperStore.open("LONG", "up", 100, 2, 100);
    paperStore.open("SHORT", "down", 100, 2, 100);
    expect(paperStore.setTotalExitTargets({ stopLoss: 0, takeProfit: 20 })).toMatch(/negative/);
    expect(paperStore.setTotalExitTargets({ stopLoss: null, takeProfit: 20 })).toBeNull();

    const long = { bid: 114, ask: 115, mark: 110 };
    const short = { bid: 103, ask: 104, mark: 103 };
    paperStore.checkTotalExitTargets((id) => id === "LONG" ? long : undefined);
    paperStore.checkTotalExitTargets((id) => id === "LONG" ? long : short);
    expect(paperStore.get().history).toHaveLength(0);

    expect(paperStore.setTotalExitTargets({ stopLoss: null, takeProfit: 15 })).toBeNull();
    const check = () => paperStore.checkTotalExitTargets((id) => id === "LONG" ? long : short);
    check();
    check();
    const { balance, positions, history, totalExitTargets } = paperStore.get();
    expect(positions).toEqual({});
    expect(totalExitTargets).toBeUndefined();
    expect(history).toMatchObject([
      { instId: "LONG", exit: 114, autoExitReason: "total_take_profit" },
      { instId: "SHORT", exit: 104, autoExitReason: "total_take_profit" },
    ]);
    expect(balance).toBeCloseTo(STARTING_BALANCE + history[0].realized + history[1].realized);
  });

  it("disarms total targets once the last position closes manually", () => {
    paperStore.open("X", "up", 100, 2, 100);
    paperStore.setTotalExitTargets({ stopLoss: -15, takeProfit: null });
    paperStore.close("X", 100);
    expect(paperStore.get().totalExitTargets).toBeUndefined();
  });

  it("round trip moves the balance by exactly the realized PnL", () => {
    expect(paperStore.open("X", "up", 500, 10, 100)).toBeNull();
    expect(paperStore.get().balance).toBeCloseTo(STARTING_BALANCE - 500 - 5000 * TAKER_FEE);
    const fill = paperStore.close("X", 102)!;
    // +$100 move on $5,000 notional, minus fees both ways
    expect(fill.realized).toBeCloseTo(100 - 5000 * TAKER_FEE - 5100 * TAKER_FEE);
    expect(paperStore.get().balance).toBeCloseTo(STARTING_BALANCE + fill.realized);
    expect(paperStore.get().history).toHaveLength(1);
  });

  it("rejects a second position, oversize margin, and missing price", () => {
    expect(paperStore.open("X", "up", 20_000, 2, 100)).toMatch(/balance/);
    expect(paperStore.open("X", "up", 100, 2, 0)).toMatch(/price/);
    expect(paperStore.open("X", "up", 100, 2, 100)).toBeNull();
    expect(paperStore.open("X", "down", 100, 2, 100)).toMatch(/Close/);
  });

  it("liquidation forfeits margin and the opening fee", () => {
    paperStore.open("X", "up", 1000, 10, 100);
    const fill = paperStore.close("X", 90, true)!;
    expect(paperStore.get().balance).toBeCloseTo(STARTING_BALANCE - 1000 - 10_000 * TAKER_FEE);
    expect(paperStore.get().balance).toBeCloseTo(STARTING_BALANCE + fill.realized);
  });
});

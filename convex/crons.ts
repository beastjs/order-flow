import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Liquidate open paper positions whose mark price crossed their liquidation price.
crons.interval("liquidation sweep", { seconds: 30 }, internal.positions.sweepLiquidations, {});
crons.interval("paper exit targets", { seconds: 30 }, internal.positions.sweepExitTargets, {});

// Real orders (no-ops unless OKX trading is configured):
// resolve any order left pending by a crash/timeout, then the ledger liquidation sweep.
crons.interval("live order reconcile", { seconds: 30 }, internal.liveTrading.reconcilePending, {});
crons.interval("live liquidation sweep", { seconds: 30 }, internal.liveTrading.sweepLiquidations, {});

export default crons;

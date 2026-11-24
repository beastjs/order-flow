import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { env } from "./_generated/server";
import { totalExitPollSeconds } from "../src/lib/paper/config";

const crons = cronJobs();

// Liquidate open paper positions whose mark price crossed their liquidation price.
crons.interval("liquidation sweep", { seconds: 30 }, internal.positions.sweepLiquidations, {});
crons.interval("paper exit targets", { seconds: 30 }, internal.positions.sweepExitTargets, {});
crons.interval("paper total exit targets", { seconds: totalExitPollSeconds(env.PAPER_TOTAL_EXIT_POLL_SECONDS) }, internal.positions.sweepTotalExitTargets, {});

// Real orders (no-ops unless OKX trading is configured):
// resolve any order left pending by a crash/timeout, then the ledger liquidation sweep.
crons.interval("live order reconcile", { seconds: 30 }, internal.liveTrading.reconcilePending, {});
crons.interval("live liquidation sweep", { seconds: 30 }, internal.liveTrading.sweepLiquidations, {});

export default crons;

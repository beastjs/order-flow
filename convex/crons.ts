import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Liquidate open paper positions whose mark price crossed their liquidation price.
crons.interval("liquidation sweep", { seconds: 30 }, internal.positions.sweepLiquidations, {});

export default crons;

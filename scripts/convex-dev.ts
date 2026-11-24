import { PAPER_TOTAL_EXIT_POLL_ENV, totalExitPollSeconds } from "../src/lib/paper/config";

const stdio = { stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const;
const configured = process.env[PAPER_TOTAL_EXIT_POLL_ENV]?.trim();

if (configured) {
  const seconds = totalExitPollSeconds(configured);
  const sync = Bun.spawn(["convex", "env", "set", PAPER_TOTAL_EXIT_POLL_ENV, String(seconds)], stdio);
  const exitCode = await sync.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

const dev = Bun.spawn(["convex", "dev"], stdio);
process.exit(await dev.exited);

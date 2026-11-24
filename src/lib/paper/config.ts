export const PAPER_TOTAL_EXIT_POLL_ENV = "PAPER_TOTAL_EXIT_POLL_SECONDS";

export function totalExitPollSeconds(value: string | undefined): number {
  const seconds = Number(value?.trim() || "60");
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`${PAPER_TOTAL_EXIT_POLL_ENV} must be a positive integer in seconds.`);
  }
  return seconds;
}

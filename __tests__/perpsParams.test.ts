// ─── /perps URL state: shared links must never break the page ──────
// Anything can arrive in a pasted URL. Every key must parse to a value
// the page can render, falling back to its default otherwise.
import { describe, expect, it } from "bun:test";
import { createLoader, createSerializer } from "@octanejs/nuqs";
import { PERPS_FILTERS, PERPS_SORTS, PERPS_VENUES, perpsParams } from "@/lib/url/perpsParams";

const load = createLoader(perpsParams);
const serialize = createSerializer(perpsParams);

describe("perps URL params", () => {
  it("defaults everything for a bare /perps", () => {
    expect(load("")).toEqual({ venue: "okx", cat: "all", sort: "volume", q: "" });
  });

  it("reads every valid value", () => {
    for (const venue of PERPS_VENUES) expect(load(`?venue=${venue}`).venue).toBe(venue);
    for (const cat of PERPS_FILTERS) expect(load(`?cat=${cat}`).cat).toBe(cat);
    for (const sort of PERPS_SORTS) expect(load(`?sort=${sort}`).sort).toBe(sort);
  });

  it("falls back to defaults for unknown, mis-cased, empty or repeated values", () => {
    for (const bad of ["binance", "OKX", "Hyperliquid", "", "okx%00", "__proto__"]) expect(load(`?venue=${bad}`).venue).toBe("okx");
    for (const bad of ["stocks", "FX", "", "constructor"]) expect(load(`?cat=${bad}`).cat).toBe("all");
    for (const bad of ["price", "VOLUME", ""]) expect(load(`?sort=${bad}`).sort).toBe("volume");
    expect(load("?venue=hyperliquid&venue=okx").venue).toBe("hyperliquid"); // first wins, still valid
  });

  it("keeps the search text verbatim (it's only ever used as a substring filter)", () => {
    for (const q of ["gbp", "xyz:GBP", "eth/", "<script>alert(1)</script>", "a&b=c", "😀", " spaced "]) {
      expect(load(serialize({ q })).q).toBe(q);
    }
  });

  it("omits defaults when writing, so a reset URL is clean", () => {
    expect(serialize({ venue: "okx", cat: "all", sort: "volume", q: "" })).toBe("");
    expect(serialize({ venue: "hyperliquid", cat: "fx", sort: "gainers", q: "gb" })).toBe("?venue=hyperliquid&cat=fx&sort=gainers&q=gb");
  });

  it("round-trips every combination", () => {
    for (const venue of PERPS_VENUES)
      for (const cat of PERPS_FILTERS)
        for (const sort of PERPS_SORTS) expect(load(serialize({ venue, cat, sort, q: "x" }))).toEqual({ venue, cat, sort, q: "x" });
  });
});

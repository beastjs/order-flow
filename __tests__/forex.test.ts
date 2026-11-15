import { FinnhubForexAdapter, isForexMarketOpen, MARKET_CLOSED_FLAG } from "@/lib/adapters/forex";
import type { VenueConnection } from "@/lib/types/market";
import { venueSupports, venuesForSelection } from "@/lib/adapters/capabilities";

describe("Forex market support", () => {
  it("keeps the FX market closed between Friday 17:00 and Sunday 17:00 New York time", () => {
    expect(isForexMarketOpen(new Date("2026-01-09T22:00:00.000Z"))).toBe(false);
    expect(isForexMarketOpen(new Date("2026-01-11T21:00:00.000Z"))).toBe(false);
    expect(isForexMarketOpen(new Date("2026-01-11T22:00:00.000Z"))).toBe(true);
  });

  it("supports currency pairs through the internal Finnhub source only", () => {
    expect(venueSupports("finnhub-forex", "EUR/USD", "forex")).toBe(true);
    expect(venueSupports("finnhub-forex", "BTCUSDT", "forex")).toBe(false);
    expect(venuesForSelection("finnhub-forex", "forex", "GBP/USD")).toEqual(["finnhub-forex"]);
  });

  describe("outside market hours", () => {
    // Sunday 03:30 New York (closed) and Sunday 17:30 New York (open).
    const CLOSED = new Date("2026-11-15T08:30:00.000Z");
    const OPEN = new Date("2026-11-15T22:30:00.000Z");
    const realWebSocket = globalThis.WebSocket;
    let sockets: FakeSocket[] = [];

    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      sent: string[] = [];
      closed = false;
      constructor(public url: string) {
        sockets.push(this);
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.closed = true;
        this.onclose?.();
      }
    }

    const track = (adapter: FinnhubForexAdapter) => {
      const seen: VenueConnection[] = [];
      adapter.on("status", (conn: VenueConnection) => seen.push(conn));
      return seen;
    };

    beforeEach(() => {
      sockets = [];
      jest.useFakeTimers();
      globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    });

    afterEach(() => {
      jest.useRealTimers();
      globalThis.WebSocket = realWebSocket;
    });

    it("reports the market as closed on connect instead of waiting for a tick", () => {
      jest.setSystemTime(CLOSED);
      const adapter = new FinnhubForexAdapter("EUR/USD");
      const seen = track(adapter);
      adapter.connect();
      expect(sockets).toHaveLength(0);
      expect(seen.at(-1)?.stateFlag).toBe(MARKET_CLOSED_FLAG);
      expect(adapter.getStatus().status).not.toBe("live");
      adapter.disconnect();
    });

    it("connects by itself once the market opens", () => {
      jest.setSystemTime(CLOSED);
      const adapter = new FinnhubForexAdapter("EUR/USD");
      adapter.connect();
      jest.setSystemTime(OPEN);
      jest.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
      sockets[0]!.onopen?.();
      expect(adapter.getStatus().status).toBe("live");
      expect(adapter.getStatus().stateFlag).toBeUndefined();
      adapter.disconnect();
    });

    it("drops the feed and reports closed when the market closes", () => {
      jest.setSystemTime(OPEN);
      const adapter = new FinnhubForexAdapter("EUR/USD");
      adapter.connect();
      sockets[0]!.onopen?.();
      jest.setSystemTime(CLOSED);
      jest.advanceTimersByTime(60_000);
      expect(sockets[0]!.closed).toBe(true);
      expect(adapter.getStatus().stateFlag).toBe(MARKET_CLOSED_FLAG);
      // No reconnect attempts while closed.
      jest.advanceTimersByTime(120_000);
      expect(sockets).toHaveLength(1);
      adapter.disconnect();
    });
  });
});

# Paper Trading Local Store (`src/lib/paper/paper.ts`)

`src/lib/paper/paper.ts` provides a browser-local, persistent paper trading store for the CFX position simulator. It enables users to trade simulated isolated-margin perpetual contracts without signing in or hitting any remote exchange or server.

All mathematical calculations and type contracts are inherited directly from [`src/lib/paper/math.ts`](file:///Users/xpriori/Code/cfx/docs/math.md) via `export * from './math'`.

---

## Table of Contents

- [Overview & Architecture](#overview--architecture)
  - [Storage & Persistence](#storage--persistence)
  - [Cross-Tab Synchronization](#cross-tab-synchronization)
  - [Subscription Mechanism](#subscription-mechanism)
- [Data Structures & Types](#data-structures--types)
  - [`PaperState`](#paperstate)
  - [Inherited Math Exports](#inherited-math-exports)
- [`paperStore` API Reference](#paperstore-api-reference)
  - [`paperStore.get()`](#paperstoreget)
  - [`paperStore.subscribe(fn)`](#paperstoresubscribefn)
  - [`paperStore.open(...)`](#paperstoreopen)
  - [`paperStore.close(...)`](#paperstoreclose)
  - [`paperStore.reset()`](#paperstorereset)
- [Balance Accounting Lifecycle](#balance-accounting-lifecycle)
- [React / Octane Integration](#react--octane-integration)
- [Related Modules](#related-modules)

---

## Overview & Architecture

### Storage & Persistence

- **Storage Key**: `cfx-paper-v1` in `window.localStorage`.
- **Initial State**: Balance initialized to `STARTING_BALANCE` (`10_000` USDT), empty `positions` map (`{}`), and empty `history` array (`[]`).
- **Resilience**: If the user is in private browsing mode, localStorage quota is exceeded, or JSON parsing fails, the store gracefully falls back to an in-memory state without crashing.

```typescript
const KEY = 'cfx-paper-v1'
const fresh = (): PaperState => ({ balance: STARTING_BALANCE, positions: {}, history: [] })
```

### Cross-Tab Synchronization

The store listens to the browser `window.addEventListener('storage', ...)` event:

```typescript
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      state = load()
      listeners.forEach((fn) => fn())
    }
  })
}
```

Whenever trades are executed in one tab, all other open browser tabs reload state from localStorage and notify their subscribers immediately.

### Subscription Mechanism

The store maintains an internal set of listener callbacks (`Set<() => void>`). Every state transition calls `commit(nextState)`:
1. Updates internal `state` reference.
2. Persists JSON serialized state to `localStorage`.
3. Invokes all registered subscriber callbacks.

This design conforms to the contract required by React / Octane's `useSyncExternalStore`.

---

## Data Structures & Types

### `PaperState`

The full serializable state stored in localStorage.

```typescript
export interface PaperState {
  balance: number
  positions: Record<string, PaperPosition>
  history: PaperFill[]
}
```

| Property | Type | Description |
| :--- | :--- | :--- |
| `balance` | `number` | Free available balance (USDT) not locked in active positions or fees. |
| `positions` | `Record<string, PaperPosition>` | Map of active open positions keyed by `instId` (e.g. `'BTC-USDT-SWAP'`). Only one active position per instrument is permitted. |
| `history` | `PaperFill[]` | Array of the most recent closed or liquidated position records, capped at the 50 most recent fills. |

### Inherited Math Exports

`paper.ts` re-exports all constants, types, and functions from [`src/lib/paper/math.ts`](file:///Users/xpriori/Code/cfx/docs/math.md):
- Constants: `STARTING_BALANCE`, `TAKER_FEE`, `MAINT_MARGIN`
- Types: `PaperSide`, `PaperPosition`, `PaperFill`, `PaperMetrics`
- Functions: `openPosition`, `closePosition`, `unrealizedPnl`, `liquidationPrice`, `isLiquidated`, `metrics`

---

## `paperStore` API Reference

The exported singleton `paperStore` provides methods to read state, subscribe to updates, and dispatch simulated trades.

```typescript
export const paperStore = {
  get(): PaperState,
  subscribe(fn: () => void): () => void,
  open(instId: string, side: PaperSide, margin: number, leverage: number, entry: number): string | null,
  close(instId: string, exit: number, liquidated?: boolean): PaperFill | null,
  reset(): void
}
```

---

### `paperStore.get()`

Synchronously returns the current `PaperState` snapshot.

```typescript
const currentState = paperStore.get()
console.log(currentState.balance, currentState.positions)
```

---

### `paperStore.subscribe(fn)`

Subscribes a listener function to state changes.

- **Parameters**: `fn: () => void` — Callback invoked on every state update.
- **Returns**: Unsubscribe cleanup function `() => void`.

```typescript
const unsubscribe = paperStore.subscribe(() => {
  console.log('Paper store updated:', paperStore.get())
})

// To unsubscribe:
unsubscribe()
```

---

### `paperStore.open(instId, side, margin, leverage, entry)`

Opens a new simulated position for the specified instrument.

```typescript
open(
  instId: string,
  side: PaperSide,
  margin: number,
  leverage: number,
  entry: number
): string | null
```

#### Validation Rules & Error Returns
1. `positions[instId]` already exists $\to$ Returns `'Close the open position first.'`.
2. `margin <= 0` or non-numeric $\to$ Returns `'Enter an amount.'`.
3. `entry <= 0` or non-numeric $\to$ Returns `'Waiting for a price.'`.
4. $\text{margin} + \text{openFee} > \text{balance} + 10^{-9}$ $\to$ Returns `'Not enough paper balance.'`.

#### State Mutation on Success
If validation passes:
1. Calls `openPosition(...)` to calculate position size and opening taker fee.
2. Debits `margin + openFee` from `balance`.
3. Stores the position under `positions[instId]`.
4. Commits state and notifies listeners.
5. Returns `null`.

---

### `paperStore.close(instId, exit, liquidated = false)`

Closes an existing position for `instId` at the given exit price.

```typescript
close(
  instId: string,
  exit: number,
  liquidated = false
): PaperFill | null
```

- **Parameters**:
  - `instId`: The instrument identifier.
  - `exit`: The market execution price (bid for Long, ask for Short) or liquidation price.
  - `liquidated`: Optional boolean (`true` if closing due to liquidation).
- **Validation**:
  - Returns `null` if no position exists for `instId` or if `exit <= 0`.
- **State Mutation on Success**:
  1. Calls `closePosition(p, exit, liquidated)` from `math.ts` to compute the fill and net `realized` PnL.
  2. Removes `instId` from `positions`.
  3. Restores balance:
     $$\text{balance}_{\text{new}} = \text{balance}_{\text{prev}} + \text{position.margin} + \text{fill.realized} + \text{position.openFee}$$
  4. Prepends `fill` to `history` and trims to the last 50 items (`slice(0, 50)`).
  5. Commits state and notifies listeners.
  6. Returns the `PaperFill` record.

---

### `paperStore.reset()`

Resets the store back to initial default values:

```typescript
paperStore.reset()
```

- Sets `balance` back to `STARTING_BALANCE` (`10_000` USDT).
- Clears all open positions (`{}`).
- Clears all trade history (`[]`).
- Persists to `localStorage` and triggers all subscriber listeners.

---

## Balance Accounting Lifecycle

The store uses a transparent accounting model:

```
[Available Balance: $10,000.00]
           │
           │  OPEN: margin = $1,000, 10x leverage, notional = $10,000
           │        taker fee (0.05%) = $5.00
           ▼
[Available Balance: $8,995.00]   (deducted: $1,000 margin + $5 openFee)
[Active Position: BTC-USDT-SWAP, Margin: $1,000, OpenFee: $5]
           │
           │  CLOSE: exit price gives +$200 gross PnL
           │         closing fee (0.05%) = $5.10
           │         realized = +$200 - $5 (open) - $5.10 (close) = +$189.90
           ▼
[Available Balance: $8,995.00 + $1,000 (margin) + $189.90 (realized) + $5 (openFee) = $10,189.90]
[History: 1 fill recorded]
```

> **Note on Balance Math**: Because `realized` PnL in `math.ts` is calculated net of both opening and closing fees (`uPnL - openFee - closeFee`), the settlement formula returns:
> $$\text{margin} + \text{realized} + \text{openFee} = \text{margin} + (\text{uPnL} - \text{openFee} - \text{closeFee}) + \text{openFee} = \text{margin} + \text{uPnL} - \text{closeFee}$$
> This accurately offsets the initial opening fee deduction without double counting.

---

## React / Octane Integration

Components subscribe to `paperStore` using `useSyncExternalStore`:

```typescript
import { useSyncExternalStore } from 'octane'
import { paperStore } from '@/lib/paper/paper'

export function useLocalPaper() {
  return useSyncExternalStore(
    paperStore.subscribe,
    paperStore.get,
    paperStore.get
  )
}
```

This is the exact mechanism utilized in [`src/hooks/usePaperAccount.ts`](file:///Users/xpriori/Code/cfx/docs/usePaperAccount.md) when the user is operating in Local practice mode.

---

## Related Modules

- [`src/lib/paper/math.ts`](file:///Users/xpriori/Code/cfx/docs/math.md) — Pure mathematical formulas for pricing, fees, and liquidations.
- [`src/hooks/usePaperAccount.ts`](file:///Users/xpriori/Code/cfx/docs/usePaperAccount.md) — Unified React hook abstracting Local Mode and Convex Cloud Mode.

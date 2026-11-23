# `usePaperAccount` Hook Documentation

`src/hooks/usePaperAccount.ts` provides React hooks and utility functions for paper trading in the CFX application. It implements a unified paper trading interface powered by a dual-backend architecture: **Cloud Mode** (authenticated Convex backend) and **Local Mode** (unauthenticated browser `localStorage` practice store).

---

## Table of Contents

- [Architecture: Dual-Backend Model](#architecture-dual-backend-model)
- [Types & Interfaces](#types--interfaces)
  - [`SimResult`](#simresult)
  - [`PaperAccount`](#paperaccount)
  - [`OpenPositionRow`](#openpositionrow)
  - [`OpenPositions`](#openpositions)
  - [`AvailableBalance`](#availablebalance)
- [Functions & Hooks Reference](#functions--hooks-reference)
  - [`usePaperAccount(instId)`](#usepaperaccountinstid)
    - [State & Properties](#state--properties)
    - [Remote Liquidation Detection](#remote-liquidation-detection)
    - [Methods](#methods)
  - [`useOpenPositions()`](#useopenpositions)
    - [State & Properties](#state--properties-1)
    - [Methods](#methods-1)
  - [`useAvailableBalance()`](#useavailablebalance)
  - [`maxMargin(available, leverage)`](#maxmarginavailable-leverage)
- [Cloud Mode vs. Local Mode Comparison](#cloud-mode-vs-local-mode-comparison)
- [Usage Examples](#usage-examples)

---

## Architecture: Dual-Backend Model

The hook abstracts whether the user is logged in or practicing as a guest:

1. **Cloud Mode** (`mode: 'cloud'`):
   - **Active when**: A Convex client instance exists and `authState.isAuthenticated` is `true`.
   - **State Source**: Convex reactive queries (`api.funds.mine`, `api.positions.openFor`, `api.positions.listMine`).
   - **Pricing**: Position execution prices are fetched and verified server-side via OKX market data.
   - **Liquidations**: Monitored and closed automatically server-side via scheduled sweep cron jobs.
   - **Persistence**: Convex database (retained across devices and sessions).

2. **Local Mode** (`mode: 'local'`):
   - **Active when**: The user is unauthenticated or Convex is unavailable.
   - **State Source**: Client-side reactive store `paperStore` synchronized with `localStorage` (`cfx-paper-v1`) via `useSyncExternalStore`.
   - **Pricing**: Execution uses live client WebSocket ticker quotes (`ask` for long/up entries, `bid` for short/down entries).
   - **Liquidations**: Evaluated and triggered client-side on incoming mark price updates (`liquidateLocal`).
   - **Persistence**: Browser `localStorage` (persisted in browser, synchronized across open tabs).

---

## Types & Interfaces

### `SimResult`

Represents the execution outcome of closing or liquidating a paper trading position.

```typescript
export type SimResult = Pick<
  PaperFill,
  'side' | 'leverage' | 'margin' | 'exit' | 'realized' | 'liquidated'
>
```

| Property | Type | Description |
| :--- | :--- | :--- |
| `side` | `'up' \| 'down'` | Direction of the trade (`'up'` = Long, `'down'` = Short). |
| `leverage` | `number` | Position leverage multiplier. |
| `margin` | `number` | Initial margin collateral allocated to the position. |
| `exit` | `number` | Execution exit price. |
| `realized` | `number` | Realized Profit & Loss (PnL), net of open and close fees. |
| `liquidated` | `boolean` | `true` if position was terminated via liquidation. |

---

### `PaperAccount`

The primary interface returned by `usePaperAccount(instId)`.

```typescript
export interface PaperAccount {
  mode: 'cloud' | 'local'
  loading: boolean
  balance: number | null
  position: PaperPosition | null
  closedRemotely: boolean
  open(
    side: PaperSide,
    margin: number,
    leverage: number,
    quote: { bid?: number; ask?: number }
  ): Promise<string | null>
  close(
    quote: { bid?: number; ask?: number }
  ): Promise<{ result: SimResult | null; error: string | null }>
  reset(): Promise<string | null>
  liquidateLocal(price: number): SimResult | null
}
```

---

### `OpenPositionRow`

Represents a single open position within the multi-position view list.

```typescript
export interface OpenPositionRow {
  key: string
  instId: string
  base: string
  position: PaperPosition
}
```

| Property | Type | Description |
| :--- | :--- | :--- |
| `key` | `string` | Unique identifier (Convex document ID in Cloud mode, `instId` in Local mode). |
| `instId` | `string` | Instrument identifier (e.g. `'BTC-USDT-SWAP'`). |
| `base` | `string` | Base asset symbol (e.g. `'BTC'`). |
| `position` | `PaperPosition` | Position details (entry, leverage, margin, size, fees, etc.). |

---

### `OpenPositions`

The interface returned by `useOpenPositions()`.

```typescript
export interface OpenPositions {
  mode: 'cloud' | 'local'
  loading: boolean
  balance: number | null
  rows: OpenPositionRow[]
  close(
    row: OpenPositionRow,
    quote: { bid?: number; ask?: number }
  ): Promise<{ result: SimResult | null; error: string | null }>
}
```

---

### `AvailableBalance`

The interface returned by `useAvailableBalance()`.

```typescript
export interface AvailableBalance {
  mode: 'cloud' | 'local'
  balance: number | null
}
```

---

## Functions & Hooks Reference

### `usePaperAccount(instId)`

```typescript
export function usePaperAccount(instId: string): PaperAccount
```

React hook that manages paper trading state and order execution for a specific trading pair (`instId`).

#### Parameters
- `instId` (`string`): The market instrument ID (e.g., `'BTC-USDT-SWAP'`).

#### State & Properties

- **`mode`**: `'cloud'` if the user is authenticated with Convex; otherwise `'local'`.
- **`loading`**:
  - Cloud: `true` while either `funds` or `positions` queries are still loading (`undefined`).
  - Local: `true` if authentication state is still loading (`authState.isLoading`).
- **`balance`**: Current free paper trading balance. `null` when loading in Cloud mode.
- **`position`**: Currently active `PaperPosition` for `instId`, or `null` if none is open.
- **`closedRemotely`**: A boolean flag that becomes `true` when a position was closed externally (e.g. liquidated by the Convex backend sweep job).

#### Remote Liquidation Detection

The hook tracks position identity using two internal refs:
- `lastIdRef`: Tracks the document ID of the active position from the previous render.
- `closedByUsRef`: Stores the position ID when the local user initiates a `close()`.

When `lastIdRef.current` existed and `remote.data` becomes empty without `closedByUsRef.current` matching the previous ID, `closedRemotely` is set to `true`. This signals to the UI that the position was liquidated or terminated by the server. Opening a new position clears this flag.

#### Methods

##### `open(side, margin, leverage, quote)`
Opens a new paper position for the current `instId`.

```typescript
open(
  side: PaperSide,
  margin: number,
  leverage: number,
  quote: { bid?: number; ask?: number }
): Promise<string | null>
```
- **Local Mode**:
  - Uses `quote.ask` for `'up'` (Long) and `quote.bid` for `'down'` (Short) as the entry price.
  - Calls `paperStore.open(instId, side, margin, leverage, entry)`.
  - Returns validation error string if invalid (e.g. `'Enter an amount.'`, `'Waiting for a price.'`, `'Not enough paper balance.'`, `'Close the open position first.'`), or `null` on success.
- **Cloud Mode**:
  - Calls Convex action `api.positions.open` with `{ instId, side, margin, leverage }`.
  - Clears `closedRemotely`.
  - Returns `null` on success or the formatted error message via `convexErrorMessage(e)` on failure.

##### `close(quote)`
Closes the current position on `instId`.

```typescript
close(
  quote: { bid?: number; ask?: number }
): Promise<{ result: SimResult | null; error: string | null }>
```
- **Local Mode**:
  - Checks if a position exists for `instId`.
  - Uses `quote.bid` for `'up'` positions and `quote.ask` for `'down'` positions as the exit price.
  - Calls `paperStore.close(instId, exit)`.
  - Returns `{ result: fill, error: null }` on success, or an error if no price is available.
- **Cloud Mode**:
  - Records the position ID into `closedByUsRef` to avoid triggering false remote liquidation alerts.
  - Calls Convex action `api.positions.close` with `{ positionId: doc._id }`.
  - Returns `{ result: SimResult, error: null }` with realized PnL and exit price, or `{ result: null, error }` on failure.

##### `reset()`
Resets the paper trading account balance and clears positions.

```typescript
reset(): Promise<string | null>
```
- **Local Mode**: Invokes `paperStore.reset()`, resetting the practice account to default starting balance and clearing positions. Returns `null`.
- **Cloud Mode**: Calls Convex mutation `api.funds.resetPaper`. Returns `null` on success or an error string on failure.

##### `liquidateLocal(price)`
Forces an immediate client-side liquidation calculation at `price`.

```typescript
liquidateLocal(price: number): SimResult | null
```
- **Local Mode**: Calls `paperStore.close(instId, price, true)`, applying liquidation penalty and recording the fill.
- **Cloud Mode**: Returns `null` (server backend cron handles liquidation sweeps).

---

### `useOpenPositions()`

```typescript
export function useOpenPositions(): OpenPositions
```

React hook used by global views (such as the `/perps` Positions tab) to display and manage all open paper trading positions across all instruments.

#### State & Properties

- **`mode`**: `'cloud' | 'local'`.
- **`loading`**: `boolean`.
- **`balance`**: Current free paper balance (`number | null`).
- **`rows`**: Array of `OpenPositionRow` objects:
  - In **Local Mode**: Derived from `Object.values(local.positions)`, sorted descending by open timestamp (`openedAt`), with `base` extracted from `instId.split('-')[0]`.
  - In **Cloud Mode**: Populated from `api.positions.listMine` (paginated up to 200 open positions).

#### Methods

##### `close(row, quote)`
Closes a specific position row from the list.

```typescript
close(
  row: OpenPositionRow,
  quote: { bid?: number; ask?: number }
): Promise<{ result: SimResult | null; error: string | null }>
```
- **Local Mode**: Uses `row.position.side` and `quote` to determine exit price, then closes via `paperStore.close(row.instId, exit)`.
- **Cloud Mode**: Calls Convex action `api.positions.close` with `{ positionId: row.key }`.

---

### `useAvailableBalance()`

```typescript
export function useAvailableBalance(): AvailableBalance
```

Lightweight hook designed for headers, navigation bars, and trade simulators that only need to display the available free paper trading balance without loading instrument-specific positions.

- **Returns**:
  ```typescript
  {
    mode: 'cloud' | 'local',
    balance: number | null
  }
  ```
- **Behavior**:
  - In **Cloud Mode**: Reads from `api.funds.mine` query (`funds.data?.balance ?? null`).
  - In **Local Mode**: Reads from `local.balance` via `paperStore` (returns `null` if auth is still resolving).

---

### `maxMargin(available, leverage)`

```typescript
export function maxMargin(available: number, leverage: number): number
```

Pure utility function calculating the maximum margin collateral affordable given the user's available balance and desired leverage, accounting for opening taker fees.

#### Formula
$$\text{maxMargin} = \left\lfloor \frac{\text{available}}{1 + (\text{leverage} \times \text{TAKER\_FEE})} \times 100 \right\rfloor \div 100$$

- Floor-rounded to the nearest cent ($0.01).
- Clamped to a minimum of `0` (`Math.max(0, ...)`).
- Ensures that when the taker opening fee ($\text{fee} = \text{margin} \times \text{leverage} \times \text{TAKER\_FEE}$) is debited at position open, the total deduction ($\text{margin} + \text{fee}$) does not exceed the available balance.

---

## Cloud Mode vs. Local Mode Comparison

| Feature | Cloud Mode (`mode: 'cloud'`) | Local Mode (`mode: 'local'`) |
| :--- | :--- | :--- |
| **Authentication** | Required (Signed in with Convex) | Optional / Unauthenticated practice |
| **Data Storage** | Convex Database | Browser `localStorage` (`cfx-paper-v1`) |
| **State Synchronization** | Reactive Convex WebSocket subscription | `useSyncExternalStore` + `window.storage` event |
| **Position Pricing** | Server-side execution via OKX | Client-side execution via WebSocket `quote` |
| **Liquidation Engine** | Server-side background cron sweeps | Client mark price check (`liquidateLocal`) |
| **Remote Liquidation Alert** | Supported (`closedRemotely: true`) | Not applicable (`closedRemotely: false`) |
| **Balance Reset** | `api.funds.resetPaper` mutation | `paperStore.reset()` local reset |

---

## Usage Examples

### 1. Trading Panel (Single Instrument)

```tsx
import { usePaperAccount, maxMargin } from '@/hooks/usePaperAccount'

function TradingPanel({ instId, ticker }: { instId: string; ticker: { bid: number; ask: number } }) {
  const { mode, balance, position, open, close, closedRemotely, loading } = usePaperAccount(instId)

  if (loading) return <div>Loading account...</div>

  const handleOpenLong = async () => {
    const leverage = 10
    const affordableMargin = maxMargin(balance ?? 0, leverage)
    const error = await open('up', affordableMargin, leverage, ticker)
    if (error) console.error('Failed to open position:', error)
  }

  const handleClose = async () => {
    const { result, error } = await close(ticker)
    if (error) console.error('Failed to close position:', error)
    else console.log('Closed position:', result)
  }

  return (
    <div>
      <p>Mode: {mode}</p>
      <p>Balance: ${balance?.toFixed(2)}</p>
      {closedRemotely && <div className="alert">Your position was liquidated by the server!</div>}
      {position ? (
        <button onClick={handleClose}>Close {position.side.toUpperCase()} Position</button>
      ) : (
        <button onClick={handleOpenLong}>Open 10x Long</button>
      )}
    </div>
  )
}
```

### 2. Header Balance Display

```tsx
import { useAvailableBalance } from '@/hooks/usePaperAccount'

export function TopBarBalance() {
  const { mode, balance } = useAvailableBalance()

  return (
    <div className="balance-pill">
      <span>{mode === 'cloud' ? 'Cloud' : 'Practice'}</span>
      <span>{balance !== null ? `$${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '...'}</span>
    </div>
  )
}
```

### 3. Open Positions Table

```tsx
import { useOpenPositions } from '@/hooks/usePaperAccount'

export function PositionsTable({ quotes }: { quotes: Record<string, { bid: number; ask: number }> }) {
  const { rows, loading, close } = useOpenPositions()

  if (loading) return <div>Loading positions...</div>
  if (rows.length === 0) return <div>No open positions.</div>

  return (
    <table>
      <thead>
        <tr>
          <th>Instrument</th>
          <th>Side</th>
          <th>Size</th>
          <th>Margin</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{row.instId}</td>
            <td>{row.position.side}</td>
            <td>{row.position.size}</td>
            <td>${row.position.margin.toFixed(2)}</td>
            <td>
              <button onClick={() => close(row, quotes[row.instId] ?? {})}>
                Close
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

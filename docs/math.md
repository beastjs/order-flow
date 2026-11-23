# Paper Trading Math (`src/lib/paper/math.ts`)

`src/lib/paper/math.ts` contains the pure mathematical models and calculations for isolated-margin perpetual futures simulation in CFX.

It contains **pure functions only**:
- No DOM dependencies.
- No storage dependencies.
- Zero external runtime imports.
- Shared directly between the client-side browser simulator ([`src/lib/paper/paper.ts`](file:///Users/xpriori/Code/cfx/src/lib/paper/paper.ts)) and the Convex cloud backend (`convex/positions.ts`).

---

## Table of Contents

- [Constants](#constants)
- [Data Structures & Types](#data-structures--types)
  - [`PaperSide`](#paperside)
  - [`PaperPosition`](#paperposition)
  - [`PaperFill`](#paperfill)
  - [`PaperMetrics`](#papermetrics)
- [Mathematical Models & Formulations](#mathematical-models--formulations)
  - [Position Sizing & Fees](#position-sizing--fees)
  - [Unrealized Profit & Loss (PnL)](#unrealized-profit--loss-pnl)
  - [Liquidation Price Derivation](#liquidation-price-derivation)
  - [Liquidation Trigger](#liquidation-trigger)
  - [Return on Equity (ROE) & Safety Margin](#return-on-equity-roe--safety-margin)
  - [Realized PnL & Loss Floor](#realized-pnl--loss-floor)
- [Function Reference](#function-reference)
  - [`openPosition(...)`](#openposition)
  - [`unrealizedPnl(...)`](#unrealizedpnl)
  - [`liquidationPrice(...)`](#liquidationprice)
  - [`isLiquidated(...)`](#isliquidated)
  - [`metrics(...)`](#metrics)
  - [`closePosition(...)`](#closeposition)
- [Related Modules](#related-modules)

---

## Constants

| Constant | Value | Description |
| :--- | :--- | :--- |
| `TAKER_FEE` | `0.0005` | 0.05% taker fee rate applied to notional trade value on opening and closing fills (mirrors standard OKX perpetual contracts). |
| `MAINT_MARGIN` | `0.005` | 0.5% maintenance margin rate ($MMR$) required to avoid liquidation. |
| `STARTING_BALANCE` | `10_000` | Default paper trading starting account balance (10,000 USDT). |

---

## Data Structures & Types

### `PaperSide`

Direction of the perpetual contract.

```typescript
export type PaperSide = 'up' | 'down'
```

- `'up'`: Long position (profits as market price rises). Direction scalar $= +1$.
- `'down'`: Short position (profits as market price falls). Direction scalar $= -1$.

---

### `PaperPosition`

Represents an actively open isolated-margin position.

```typescript
export interface PaperPosition {
  instId: string
  side: PaperSide
  /** Margin committed in USDT */
  margin: number
  leverage: number
  entry: number
  /** Base units (shares / coins) */
  size: number
  openFee: number
  openedAt: number
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `instId` | `string` | Instrument identifier (e.g. `'BTC-USDT-SWAP'`). |
| `side` | `PaperSide` | `'up'` (Long) or `'down'` (Short). |
| `margin` | `number` | Collateral allocated to the position (USDT). |
| `leverage` | `number` | Selected leverage multiplier (e.g. 10x, 20x). |
| `entry` | `number` | Position entry price (USDT). |
| `size` | `number` | Base asset contract units ($\text{Notional} \div \text{entry}$). |
| `openFee` | `number` | Taker fee paid at position open in USDT ($\text{Notional} \times \text{TAKER\_FEE}$). |
| `openedAt` | `number` | Unix millisecond timestamp when the position was opened. |

---

### `PaperFill`

Represents an execution record when a position is closed or liquidated.

```typescript
export interface PaperFill {
  instId: string
  side: PaperSide
  leverage: number
  margin: number
  entry: number
  exit: number
  /** Net of both fees; -(margin + open fee) when liquidated */
  realized: number
  liquidated: boolean
  openedAt: number
  closedAt: number
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `instId` | `string` | Instrument identifier. |
| `side` | `PaperSide` | Direction of the closed position. |
| `leverage` | `number` | Leverage multiplier used. |
| `margin` | `number` | Margin collateral committed. |
| `entry` | `number` | Fill price at open. |
| `exit` | `number` | Fill price at close / liquidation. |
| `realized` | `number` | Net realized PnL in USDT (net of opening and closing fees). |
| `liquidated` | `boolean` | `true` if closed due to liquidation; `false` if closed normally. |
| `openedAt` | `number` | Millisecond timestamp when the position opened. |
| `closedAt` | `number` | Millisecond timestamp when the position was filled/closed. |

---

### `PaperMetrics`

Calculated real-time position health, valuation, and risk metrics.

```typescript
export interface PaperMetrics {
  pnl: number
  /** PnL net of the opening fee, as % of margin */
  roe: number
  notional: number
  liq: number
  /** 0 = at liquidation, 1 = at entry or better */
  safety: number
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `pnl` | `number` | Unrealized PnL at mark price before fees. |
| `roe` | `number` | Return on Equity percentage, net of opening fee. |
| `notional` | `number` | Current position notional value ($\text{size} \times \text{mark}$). |
| `liq` | `number` | Estimated liquidation mark price. |
| `safety` | `number` | Normalized risk ratio $[0, 1]$ ($0 = \text{liquidated}$, $1 = \text{entry or higher}$). |

---

## Mathematical Models & Formulations

### Position Sizing & Fees

When an order is created:

$$\text{Notional} = \text{margin} \times \text{leverage}$$

$$\text{size} = \frac{\text{Notional}}{\text{entry}}$$

$$\text{openFee} = \text{Notional} \times \text{TAKER\_FEE}$$

---

### Unrealized Profit & Loss (PnL)

$$\text{dir} = \begin{cases} +1 & \text{if } \text{side} = \text{'up'} \\ -1 & \text{if } \text{side} = \text{'down'} \end{cases}$$

$$\text{uPnL}(\text{price}) = \text{dir} \times (\text{price} - \text{entry}) \times \text{size}$$

---

### Liquidation Price Derivation

Liquidation occurs when remaining position equity reaches the required maintenance margin:

$$\text{Equity}_0 = \text{margin} - \text{openFee}$$

$$\text{Equity}(P) = \text{Equity}_0 + \text{uPnL}(P)$$

$$\text{Required Maintenance Margin}(P) = P \times \text{size} \times \text{MAINT\_MARGIN}$$

Equating $\text{Equity}(P_{\text{liq}}) = \text{Required Maintenance Margin}(P_{\text{liq}})$ yields:

#### 1. Long (`'up'`) Positions:
$$\text{Equity}_0 + (P_{\text{liq}} - \text{entry}) \times \text{size} = P_{\text{liq}} \times \text{size} \times \text{MAINT\_MARGIN}$$

$$P_{\text{liq}} = \max\left(0, \frac{\text{entry} \times \text{size} - \text{Equity}_0}{\text{size} \times (1 - \text{MAINT\_MARGIN})}\right)$$

#### 2. Short (`'down'`) Positions:
$$\text{Equity}_0 - (P_{\text{liq}} - \text{entry}) \times \text{size} = P_{\text{liq}} \times \text{size} \times \text{MAINT\_MARGIN}$$

$$P_{\text{liq}} = \frac{\text{Equity}_0 + \text{entry} \times \text{size}}{\text{size} \times (1 + \text{MAINT\_MARGIN})}$$

---

### Liquidation Trigger

A position is considered liquidated at mark price $P_{\text{mark}}$ if:

$$\text{isLiquidated} = \begin{cases} P_{\text{mark}} \le P_{\text{liq}} & \text{for Long (`'up'`)} \\ P_{\text{mark}} \ge P_{\text{liq}} & \text{for Short (`'down'`)} \end{cases}$$

---

### Return on Equity (ROE) & Safety Margin

#### Return on Equity (ROE):
$$\text{ROE} = \left(\frac{\text{uPnL} - \text{openFee}}{\text{margin}}\right) \times 100\%$$

#### Safety Score ($[0, 1]$):
Measures proximity of current price to liquidation price relative to the distance between entry and liquidation:

$$\text{span} = |\text{entry} - P_{\text{liq}}|$$

$$\text{safety} = \operatorname{clamp}\left(0, \frac{|P_{\text{mark}} - P_{\text{liq}}|}{\text{span}}, 1\right)$$

- `1.0`: Mark price is at or more favorable than entry price.
- `0.0`: Mark price has reached the liquidation boundary.

---

### Realized PnL & Loss Floor

CFX enforces strict isolated-margin risk protection: **a user can never lose more than the total collateral committed to the position** (initial margin plus opening fee).

$$\text{floor} = -(\text{margin} + \text{openFee})$$

#### Normal Exit:
$$\text{closeFee} = \text{size} \times \text{exit} \times \text{TAKER\_FEE}$$

$$\text{realized} = \max\Big(\text{floor}, \text{uPnL}(\text{exit}) - \text{openFee} - \text{closeFee}\Big)$$

#### Liquidated Exit:
When liquidated, the entire committed collateral is forfeit:

$$\text{realized} = \text{floor} = -(\text{margin} + \text{openFee})$$

---

## Function Reference

### `openPosition`

Constructs a new `PaperPosition` object.

```typescript
export function openPosition(
  instId: string,
  side: PaperSide,
  margin: number,
  leverage: number,
  entry: number,
  now = Date.now()
): PaperPosition
```

- **Parameters**:
  - `instId`: Instrument identifier (e.g. `'BTC-USDT-SWAP'`).
  - `side`: `'up'` or `'down'`.
  - `margin`: Collateral in USDT.
  - `leverage`: Leverage multiple (e.g. `10`).
  - `entry`: Market execution entry price.
  - `now`: Optional timestamp override (defaults to `Date.now()`).
- **Returns**: Fully computed `PaperPosition` with base `size` and `openFee`.

---

### `unrealizedPnl`

Calculates gross unrealized profit or loss at a given price before deducting fees.

```typescript
export function unrealizedPnl(p: PaperPosition, price: number): number
```

---

### `liquidationPrice`

Calculates the exact price at which the position's equity breaches the maintenance margin threshold.

```typescript
export function liquidationPrice(p: PaperPosition): number
```

---

### `isLiquidated`

Evaluates whether a given mark price breaches the position's liquidation price.

```typescript
export function isLiquidated(p: PaperPosition, mark: number): boolean
```

---

### `metrics`

Calculates a consolidated snapshot of position metrics at the current mark price.

```typescript
export function metrics(p: PaperPosition, mark: number): PaperMetrics
```

- **Returns**: `{ pnl, roe, notional, liq, safety }`.

---

### `closePosition`

Evaluates position settlement at an exit price and produces a `PaperFill`.

```typescript
export function closePosition(
  p: PaperPosition,
  exit: number,
  liquidated = false,
  now = Date.now()
): PaperFill
```

- **Parameters**:
  - `p`: The active `PaperPosition`.
  - `exit`: Fill price at close.
  - `liquidated`: Flag indicating forced liquidation.
  - `now`: Timestamp of closing execution.
- **Returns**: A finalized `PaperFill` object with clamped `realized` PnL.

---

## Related Modules

- [`src/lib/paper/paper.ts`](file:///Users/xpriori/Code/cfx/docs/paper.md) — Browser-local reactive store using these math functions.
- [`src/hooks/usePaperAccount.ts`](file:///Users/xpriori/Code/cfx/docs/usePaperAccount.md) — Unified React hook interface for paper trading.
- `convex/positions.ts` — Convex backend functions running the identical math server-side.

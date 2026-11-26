import { ExchangeClient, HttpTransport, InfoClient, TransportError } from '@nktkas/hyperliquid'
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils'
import type { AbstractViemJsonRpcAccount } from '@nktkas/hyperliquid/signing'
import { isAddressEqual, type Address, type WalletClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hlTickSz, splitHlCoin } from './rest'

const transport = new HttpTransport()
const info = new InfoClient({ transport })
const agents = new Map<Address, ExchangeClient>()
const submissions = new Set<string>()
type PendingOrder = { oid: `0x${string}`; expiresAfter: number }
const pendingOrders = new Map<string, PendingOrder>()
const AGENT_NAME = 'CFX Trading'
const SLIPPAGE = 0.005
export const LIVE_REVIEW_MS = 30_000

const accountKey = (user: Address, coin: string) => `${user.toLowerCase()}:${coin}`

function readPending(key: string): PendingOrder | undefined {
  const inMemory = pendingOrders.get(key)
  if (inMemory) return inMemory
  try {
    const stored = sessionStorage.getItem(`cfx-hl-order:${key}`)
    if (!stored) return
    const { oid, expiresAfter } = JSON.parse(stored)
    if (typeof oid === 'string' && /^0x[a-f0-9]{32}$/.test(oid) && Number.isSafeInteger(expiresAfter)) {
      return { oid: oid as `0x${string}`, expiresAfter }
    }
  } catch {
    // The in-memory record also supports browsers with storage disabled.
  }
}

function writePending(key: string, pending?: PendingOrder) {
  if (pending) pendingOrders.set(key, pending)
  else pendingOrders.delete(key)
  try {
    const storageKey = `cfx-hl-order:${key}`
    if (pending) sessionStorage.setItem(storageKey, JSON.stringify(pending))
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Storage may be unavailable even when trading is permitted.
  }
}

export const hasHlTradingSession = (user: Address) => agents.has(user.toLowerCase() as Address)

export async function authorizeHlTrading(user: Address, wallet: WalletClient) {
  const agent = privateKeyToAccount(generatePrivateKey())
  const assertWallet = async () => {
    const [active] = await wallet.getAddresses()
    if (!active || !isAddressEqual(active, user)) throw new Error('Your wallet changed. Reconnect and try again.')
  }
  const signer: AbstractViemJsonRpcAccount = {
    getAddresses: async () => [user],
    getChainId: () => wallet.getChainId(),
    async signTypedData(data) {
      await assertWallet()
      const signature = await wallet.signTypedData({ ...data, account: user })
      await assertWallet()
      return signature
    }
  }
  // The agent's key remains in memory and is discarded when the page is reloaded.
  await new ExchangeClient({ transport, wallet: signer }).approveAgent({ agentAddress: agent.address, agentName: AGENT_NAME })
  agents.set(user.toLowerCase() as Address, new ExchangeClient({ transport, wallet: agent }))
}

export async function fetchHlTradingAccount(user: Address, coin: string) {
  const { dex } = splitHlCoin(coin)
  const [state, asset] = await Promise.all([
    info.clearinghouseState({ user, dex }),
    info.activeAssetData({ user, coin })
  ])
  const position = state.assetPositions.find(({ position }) => position.coin === coin)?.position
  return { position: position && Number(position.szi) !== 0 ? position : null, asset }
}

export interface HlOrderPreview {
  user: Address
  coin: string
  asset: number
  buy: boolean
  size: string
  limit: string
  reduceOnly: boolean
  positionSize: string | null
  leverage: { value: number; type: 'cross' | 'isolated' }
  expiresAfter: number
}

export function hlIocLimit(touch: number, buy: boolean, szDecimals: number): string {
  if (!Number.isFinite(touch) || touch <= 0) throw new Error('Hyperliquid has no executable quote.')
  const boundary = touch * (buy ? 1 + SLIPPAGE : 1 - SLIPPAGE)
  const tick = hlTickSz(szDecimals, boundary)
  const ticks = buy ? Math.floor(boundary / tick) : Math.ceil(boundary / tick)
  const price = formatPrice((ticks * tick).toFixed(6 - szDecimals), szDecimals)
  if (buy ? Number(price) < touch : Number(price) > touch) throw new Error('Hyperliquid has no executable quote within the price limit.')
  return price
}

export async function reviewHlOrder(user: Address, coin: string, request: { buy: boolean; notional: number } | { close: true }): Promise<HlOrderPreview> {
  const { dex } = splitHlCoin(coin)
  const [meta, dexes, account, book] = await Promise.all([
    info.meta({ dex }),
    dex ? info.perpDexs() : [],
    fetchHlTradingAccount(user, coin),
    info.l2Book({ coin })
  ])
  const index = meta.universe.findIndex(({ name }) => name === coin)
  const market = meta.universe[index]
  const dexIndex = dex ? dexes.findIndex((item) => item?.name === dex) : 0
  if (!market || market.isDelisted || (dex && dexIndex < 1)) throw new Error('This Hyperliquid perpetual is unavailable.')
  const asset = dex ? 100_000 + dexIndex * 10_000 + index : index
  const reduceOnly = 'close' in request
  const positionSize = account.position?.szi ?? null
  if (reduceOnly && !positionSize) throw new Error('Your Hyperliquid position is already closed.')
  if (!reduceOnly && positionSize) throw new Error('Close your existing position before opening another.')
  if (!book || book.coin !== coin || Date.now() - book.time > 15_000) throw new Error('Waiting for a current Hyperliquid order book.')

  const buy = reduceOnly ? Number(positionSize) < 0 : request.buy
  const touch = Number(book.levels[buy ? 1 : 0][0]?.px)
  const limit = hlIocLimit(touch, buy, market.szDecimals)
  const quantity = reduceOnly ? positionSize!.replace(/^-/, '') : request.notional / Math.max(touch, Number(limit))
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) throw new Error('Enter a valid order notional.')
  const size = formatSize(quantity, market.szDecimals)
  if (!reduceOnly && Number(size) > Number(account.asset.maxTradeSzs[buy ? 0 : 1])) {
    throw new Error('This order exceeds your available trading size on Hyperliquid.')
  }
  const { value, type } = account.asset.leverage
  return { user, coin, asset, buy, size, limit, reduceOnly, positionSize, leverage: { value, type }, expiresAfter: Date.now() + LIVE_REVIEW_MS }
}

export async function checkHlOrder(user: Address, coin: string): Promise<string | null> {
  const key = accountKey(user, coin)
  const pending = readPending(key)
  if (!pending) return null
  if (submissions.has(key)) throw new Error('Hyperliquid is still processing this order.')
  const result = await info.orderStatus({ user, oid: pending.oid })
  if (result.status === 'unknownOid') {
    if (Date.now() <= pending.expiresAfter + 15_000) throw new Error('Waiting for Hyperliquid to confirm the order. Check its status again shortly.')
    writePending(key)
    return 'Hyperliquid could not find the expired order.'
  }
  const { status, order } = result.order
  if (status === 'open' || status === 'triggered') throw new Error('Hyperliquid is still processing this order.')
  writePending(key)
  return `Hyperliquid order #${order.oid} · ${status}`
}

export function hasPendingHlOrder(user: Address, coin: string) {
  return Boolean(readPending(accountKey(user, coin)))
}

export async function submitHlOrder(preview: HlOrderPreview, isCurrentWallet: () => Promise<boolean>) {
  const { user, coin, asset, buy, size, limit, reduceOnly, positionSize, leverage, expiresAfter } = preview
  const exchange = agents.get(user.toLowerCase() as Address)
  if (!exchange) throw new Error('Authorize live trading for this wallet first.')
  const key = accountKey(user, coin)
  if (submissions.has(key) || readPending(key)) throw new Error('Check the previous order before submitting another.')
  submissions.add(key)
  try {
    const { position, asset: current } = await fetchHlTradingAccount(user, coin)
    if ((position?.szi ?? null) !== positionSize) throw new Error('Your position changed. Review a new order.')
    if (!reduceOnly && (current.leverage.value !== leverage.value || current.leverage.type !== leverage.type)) {
      throw new Error('Your leverage or margin mode changed. Review a new order.')
    }
    if (!(await isCurrentWallet())) throw new Error('Your wallet changed. Review a new order.')
    if (Date.now() >= expiresAfter) throw new Error('The price review expired. Review a new order.')
    const oid = `0x${crypto.randomUUID().replace(/-/g, '')}` as const
    writePending(key, { oid, expiresAfter })
    try {
      const result = await exchange.order({
        orders: [{ a: asset, b: buy, p: limit, s: size, r: reduceOnly, t: { limit: { tif: 'Ioc' } }, c: oid }],
        grouping: 'na'
      }, { expiresAfter })
      const status = result?.response?.data?.statuses?.[0]
      if (status && typeof status === 'object' && 'filled' in status) {
        writePending(key)
        return status.filled
      }
    } catch (error) {
      if (!(error instanceof TransportError)) {
        writePending(key)
        throw error
      }
    }
    throw new Error('Hyperliquid did not confirm the fill. Check the order status before submitting another.')
  } finally {
    submissions.delete(key)
  }
}

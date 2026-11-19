// ============================================================
// HYPERLIQUID WEBSOCKET CLIENT
// One socket shared by every consumer. Subscriptions are
// ref-counted: N listeners on the same feed cost one Hyperliquid
// subscription. The socket opens on the first subscription, closes
// shortly after the last one goes, and on reconnect re-subscribes
// everything that is still wanted.
// ============================================================

import type { HlFrame, HlSocketStatus, HlSubscription } from './types'

export const HL_WS_HOSTS = {
  mainnet: 'wss://api.hyperliquid.xyz/ws',
  testnet: 'wss://api.hyperliquid-testnet.xyz/ws'
} as const

const PING_AFTER_MS = 30_000 // Hyperliquid drops a connection it hasn't heard from in 60s
const DEAD_AFTER_MS = 45_000 // no message (not even "pong") → force reconnect
const IDLE_CLOSE_MS = 5_000 // linger before closing an unused socket

export type FrameHandler<T = unknown> = (data: T) => void
export type StatusHandler = (status: HlSocketStatus) => void
export type ErrorHandler = (error: { msg: string }) => void

/** Stable key for a subscription. Must match `frameKey` for its pushes. */
export function subKey(sub: HlSubscription): string {
  const s = sub as { type: string; coin?: string; dex?: string; interval?: string }
  return `${s.type}|${s.coin ?? s.dex ?? ''}|${s.interval ?? ''}`
}

/** Key of the subscription a push frame belongs to, or null if not a data frame. */
export function frameKey(frame: HlFrame<any>): string | null {
  const d = frame.data
  switch (frame.channel) {
    case 'allMids':
      return `allMids|${d?.dex ?? ''}|`
    case 'l2Book':
    case 'bbo':
    case 'activeAssetCtx':
      return `${frame.channel}|${d?.coin ?? ''}|`
    // Spot coins ("@107", "PURR/USDC") answer activeAssetCtx on this channel.
    case 'activeSpotAssetCtx':
      return `activeAssetCtx|${d?.coin ?? ''}|`
    case 'trades':
      return Array.isArray(d) && d.length ? `trades|${d[0].coin}|` : null
    case 'candle':
      return `candle|${d?.s ?? ''}|${d?.i ?? ''}`
    default:
      return null
  }
}

interface Subscription {
  sub: HlSubscription
  handlers: Set<FrameHandler>
}

type WebSocketCtor = new (url: string) => WebSocket

export interface HlStreamOptions {
  url?: string
  /** Injected for tests; defaults to globalThis.WebSocket. */
  WebSocketImpl?: WebSocketCtor
}

export class HlStream {
  private readonly url: string
  private readonly WS: WebSocketCtor
  private ws: WebSocket | null = null
  private subs = new Map<string, Subscription>()
  private status: HlSocketStatus = 'idle'
  private attempts = 0
  private lastMessage = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private statusHandlers = new Set<StatusHandler>()
  private errorHandlers = new Set<ErrorHandler>()

  constructor(options: HlStreamOptions = {}) {
    this.url = options.url ?? HL_WS_HOSTS.mainnet
    this.WS = options.WebSocketImpl ?? (globalThis.WebSocket as WebSocketCtor)
  }

  getStatus(): HlSocketStatus {
    return this.status
  }

  /** Number of distinct Hyperliquid subscriptions currently wanted. */
  get size(): number {
    return this.subs.size
  }

  subscribe<T>(sub: HlSubscription, handler: FrameHandler<T>): () => void {
    const key = subKey(sub)
    let entry = this.subs.get(key)
    if (!entry) {
      entry = { sub, handlers: new Set() }
      this.subs.set(key, entry)
      if (this.isOpen()) this.send('subscribe', sub)
    }
    entry.handlers.add(handler as FrameHandler)
    this.cancelIdleClose()
    this.ensureConnected()

    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.subs.get(key)
      if (!current) return
      current.handlers.delete(handler as FrameHandler)
      if (current.handlers.size > 0) return
      this.subs.delete(key)
      if (this.isOpen()) this.send('unsubscribe', sub)
      if (this.subs.size === 0) this.scheduleIdleClose()
    }
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  /** Close now and forget all subscriptions. */
  destroy(): void {
    this.subs.clear()
    this.cancelIdleClose()
    this.teardown()
    this.setStatus('closed')
  }

  /** Exposed for tests: feed one raw frame as if received. */
  handleFrame(raw: string): void {
    this.lastMessage = Date.now()
    let frame: HlFrame<any>
    try {
      frame = JSON.parse(raw)
    } catch {
      this.emitError(`Unparseable Hyperliquid frame: ${raw.slice(0, 120)}`)
      return
    }
    // Valid JSON that isn't an object ("null", "42") would throw below.
    if (!frame || typeof frame !== 'object') {
      this.emitError(`Unexpected Hyperliquid frame: ${raw.slice(0, 120)}`)
      return
    }
    if (frame.channel === 'pong' || frame.channel === 'subscriptionResponse') return
    if (frame.channel === 'error') {
      this.emitError(typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data))
      return
    }
    const key = frameKey(frame)
    const entry = key ? this.subs.get(key) : undefined
    if (!entry) return
    for (const handler of entry.handlers) {
      try {
        handler(frame.data)
      } catch (error) {
        console.error('[hyperliquid] handler threw', error)
      }
    }
  }

  // ─── connection lifecycle ─────────────────────────────────

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1 /* OPEN */
  }

  private ensureConnected(): void {
    if (this.ws || this.reconnectTimer || this.subs.size === 0) return
    this.open()
  }

  private open(): void {
    this.setStatus(this.attempts > 0 ? 'reconnecting' : 'connecting')
    const ws = new this.WS(this.url)
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.attempts = 0
      this.lastMessage = Date.now()
      this.setStatus('open')
      this.startHeartbeat()
      for (const { sub } of this.subs.values()) this.send('subscribe', sub)
    }
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws === ws) this.handleFrame(String(event.data))
    }
    ws.onerror = () => {
      if (this.ws === ws) this.emitError('Hyperliquid WebSocket error')
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.teardown()
      if (this.subs.size > 0) this.scheduleReconnect()
      else this.setStatus('closed')
    }
  }

  private teardown(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState <= 1) {
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(500 * 2 ** this.attempts, 30_000) * (0.75 + Math.random() * 0.5)
    this.attempts++
    this.setStatus('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.subs.size > 0) this.open()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      const silent = Date.now() - this.lastMessage
      if (silent > DEAD_AFTER_MS) {
        // Half-open socket: drop it and reconnect.
        this.teardown()
        this.scheduleReconnect()
      } else if (silent > PING_AFTER_MS && this.isOpen()) {
        this.ws!.send(JSON.stringify({ method: 'ping' }))
      }
    }, 5_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.subs.size === 0) {
        this.attempts = 0
        this.teardown()
        this.setStatus('idle')
      }
    }, IDLE_CLOSE_MS)
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private send(method: 'subscribe' | 'unsubscribe', subscription: HlSubscription): void {
    this.ws!.send(JSON.stringify({ method, subscription }))
  }

  private emitError(msg: string): void {
    if (this.errorHandlers.size === 0) console.warn('[hyperliquid]', msg)
    this.errorHandlers.forEach((fn) => fn({ msg }))
  }

  private setStatus(status: HlSocketStatus): void {
    if (this.status === status) return
    this.status = status
    this.statusHandlers.forEach((fn) => fn(status))
  }
}

// ============================================================
// OKX V5 WEBSOCKET CLIENT
// One socket per endpoint (public / business), shared by every
// consumer. Subscriptions are ref-counted: N listeners on the same
// channel+instrument cost one OKX subscription. The socket opens on
// the first subscription, closes shortly after the last one goes,
// and on reconnect re-subscribes everything that is still wanted.
// ============================================================

import type {
  OkxBusinessChannel,
  OkxChannel,
  OkxEndpoint,
  OkxEventFrame,
  OkxPush,
  OkxSocketStatus,
  OkxSubscriptionArg
} from './types'

/** Port 443. OKX is retiring 8443 (notice code 64010). */
export const OKX_WS_HOSTS = {
  production: 'wss://ws.okx.com',
  /** Demo trading environment. */
  demo: 'wss://wspap.okx.com'
} as const

const PING_AFTER_MS = 20_000 // OKX drops a connection that is silent for 30s
const DEAD_AFTER_MS = 35_000 // no message (not even "pong") → force reconnect
const IDLE_CLOSE_MS = 5_000 // linger before closing an unused socket
const MAX_ARGS_PER_REQUEST = 100

export type PushHandler<T = unknown> = (push: OkxPush<T>) => void
export type StatusHandler = (status: OkxSocketStatus, endpoint: OkxEndpoint) => void
export type ErrorHandler = (error: { code?: string; msg: string; endpoint: OkxEndpoint; arg?: OkxSubscriptionArg }) => void

export function argKey(arg: OkxSubscriptionArg): string {
  return `${arg.channel}|${arg.instId ?? ''}|${arg.instType ?? ''}|${arg.instFamily ?? ''}`
}

const BUSINESS_PREFIXES = ['candle', 'mark-price-candle', 'index-candle']

/** Which endpoint serves a channel. */
export function endpointFor(channel: OkxChannel): OkxEndpoint {
  if (channel === 'trades-all') return 'business'
  return BUSINESS_PREFIXES.some((p) => channel.startsWith(p)) ? 'business' : 'public'
}

export function isBusinessChannel(channel: OkxChannel): channel is OkxBusinessChannel {
  return endpointFor(channel) === 'business'
}

interface Subscription {
  arg: OkxSubscriptionArg
  handlers: Set<PushHandler>
}

type WebSocketCtor = new (url: string) => WebSocket

export interface OkxSocketOptions {
  url: string
  endpoint: OkxEndpoint
  /** Injected for tests; defaults to globalThis.WebSocket. */
  WebSocketImpl?: WebSocketCtor
  onStatus?: StatusHandler
  onError?: ErrorHandler
}

export class OkxSocket {
  readonly endpoint: OkxEndpoint
  private readonly url: string
  private readonly WS: WebSocketCtor
  private readonly onStatus?: StatusHandler
  private readonly onError?: ErrorHandler
  private ws: WebSocket | null = null
  private subs = new Map<string, Subscription>()
  private status: OkxSocketStatus = 'idle'
  private attempts = 0
  private lastMessage = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: OkxSocketOptions) {
    this.url = options.url
    this.endpoint = options.endpoint
    this.WS = options.WebSocketImpl ?? (globalThis.WebSocket as WebSocketCtor)
    this.onStatus = options.onStatus
    this.onError = options.onError
  }

  getStatus(): OkxSocketStatus {
    return this.status
  }

  /** Number of distinct OKX subscriptions currently wanted. */
  get size(): number {
    return this.subs.size
  }

  subscribe<T>(arg: OkxSubscriptionArg, handler: PushHandler<T>): () => void {
    const key = argKey(arg)
    let sub = this.subs.get(key)
    if (!sub) {
      sub = { arg, handlers: new Set() }
      this.subs.set(key, sub)
      if (this.isOpen()) this.send('subscribe', [arg])
    }
    sub.handlers.add(handler as PushHandler)
    this.cancelIdleClose()
    this.ensureConnected()

    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.subs.get(key)
      if (!current) return
      current.handlers.delete(handler as PushHandler)
      if (current.handlers.size > 0) return
      this.subs.delete(key)
      if (this.isOpen()) this.send('unsubscribe', [arg])
      if (this.subs.size === 0) this.scheduleIdleClose()
    }
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
    if (raw === 'pong') return
    let frame: OkxPush | OkxEventFrame
    try {
      frame = JSON.parse(raw)
    } catch {
      this.onError?.({ msg: `Unparseable OKX frame: ${raw.slice(0, 120)}`, endpoint: this.endpoint })
      return
    }
    // Valid JSON that isn't an object ("null", "42") would make `in` throw.
    if (!frame || typeof frame !== 'object') {
      this.onError?.({ msg: `Unexpected OKX frame: ${raw.slice(0, 120)}`, endpoint: this.endpoint })
      return
    }
    if ('event' in frame) {
      if (frame.event === 'error' || frame.event === 'channel-conn-count-error') {
        this.onError?.({ code: frame.code, msg: frame.msg ?? 'OKX error', endpoint: this.endpoint, arg: frame.arg })
      }
      return
    }
    if (!frame.arg || !Array.isArray(frame.data)) return
    const sub = this.subs.get(argKey(frame.arg))
    if (!sub) return
    for (const handler of sub.handlers) {
      try {
        handler(frame)
      } catch (error) {
        console.error('[okx] handler threw', error)
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
      const args = [...this.subs.values()].map((s) => s.arg)
      if (args.length) this.send('subscribe', args)
    }
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws === ws) this.handleFrame(String(event.data))
    }
    ws.onerror = () => {
      if (this.ws === ws) this.onError?.({ msg: `OKX ${this.endpoint} WebSocket error`, endpoint: this.endpoint })
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
        // Half-open socket: drop it and let onclose-path reconnect.
        this.teardown()
        this.scheduleReconnect()
      } else if (silent > PING_AFTER_MS && this.isOpen()) {
        this.ws!.send('ping')
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

  private send(op: 'subscribe' | 'unsubscribe', args: OkxSubscriptionArg[]): void {
    for (let i = 0; i < args.length; i += MAX_ARGS_PER_REQUEST) {
      this.ws!.send(JSON.stringify({ op, args: args.slice(i, i + MAX_ARGS_PER_REQUEST) }))
    }
  }

  private setStatus(status: OkxSocketStatus): void {
    if (this.status === status) return
    this.status = status
    this.onStatus?.(status, this.endpoint)
  }
}

// ============================================================
// OkxStream — routes each channel to the right endpoint
// ============================================================

export interface OkxStreamOptions {
  host?: string
  WebSocketImpl?: WebSocketCtor
}

export class OkxStream {
  readonly public: OkxSocket
  readonly business: OkxSocket
  private statusHandlers = new Set<StatusHandler>()
  private errorHandlers = new Set<ErrorHandler>()

  constructor(options: OkxStreamOptions = {}) {
    const host = options.host ?? OKX_WS_HOSTS.production
    const shared = {
      WebSocketImpl: options.WebSocketImpl,
      onStatus: (s: OkxSocketStatus, e: OkxEndpoint) => this.statusHandlers.forEach((fn) => fn(s, e)),
      onError: (err: Parameters<ErrorHandler>[0]) => {
        if (this.errorHandlers.size === 0) console.warn(`[okx:${err.endpoint}]`, err.code ?? '', err.msg)
        this.errorHandlers.forEach((fn) => fn(err))
      }
    }
    this.public = new OkxSocket({ ...shared, endpoint: 'public', url: `${host}/ws/v5/public` })
    this.business = new OkxSocket({ ...shared, endpoint: 'business', url: `${host}/ws/v5/business` })
  }

  socket(endpoint: OkxEndpoint): OkxSocket {
    return endpoint === 'business' ? this.business : this.public
  }

  subscribe<T>(arg: OkxSubscriptionArg, handler: PushHandler<T>): () => void {
    return this.socket(endpointFor(arg.channel)).subscribe(arg, handler)
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  destroy(): void {
    this.public.destroy()
    this.business.destroy()
  }
}

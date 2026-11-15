import type { DetectedWallet, EIP1193Provider } from './types'

// Browser wallet discovery (EIP-6963). Each installed extension announces
// itself with a name, icon and its own provider, so several wallets can be
// offered side by side instead of whichever one won window.ethereum.

interface AnnounceDetail {
  info?: { uuid?: unknown; name?: unknown; icon?: unknown; rdns?: unknown }
  provider?: unknown
}

const LEGACY_ID = 'injected'

const announced = new Map<string, DetectedWallet>()
const listeners = new Set<() => void>()
let snapshot: readonly DetectedWallet[] = []
let started = false

function isProvider(value: unknown): value is EIP1193Provider {
  return typeof value === 'object' && value !== null && 'request' in value && typeof value.request === 'function'
}

// Icons come from the extension. Only inline images are accepted, so an icon
// can never trigger a network request or navigate.
function safeIcon(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('data:image/') ? value : undefined
}

function rebuild(): void {
  const wallets = [...announced.values()]

  // A wallet that predates EIP-6963 only sets window.ethereum.
  if (wallets.length === 0 && window.ethereum) {
    wallets.push({ id: LEGACY_ID, name: 'Browser wallet', provider: window.ethereum })
  }

  snapshot = wallets
  listeners.forEach((listener) => listener())
}

function onAnnounce(event: Event): void {
  const detail = (event as CustomEvent<AnnounceDetail>).detail
  const info = detail?.info

  if (!info || typeof info.name !== 'string' || !isProvider(detail.provider)) {
    return
  }

  // rdns is stable across page loads; uuid is not, so it is only a fallback.
  const id = typeof info.rdns === 'string' && info.rdns ? info.rdns : typeof info.uuid === 'string' ? info.uuid : ''

  if (!id || announced.get(id)?.provider === detail.provider) {
    return
  }

  announced.set(id, { id, name: info.name, icon: safeIcon(info.icon), provider: detail.provider })
  rebuild()
}

function start(): void {
  if (started || typeof window === 'undefined') {
    return
  }

  started = true
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  rebuild()
  window.dispatchEvent(new Event('eip6963:requestProvider'))
}

export function getDetectedWallets(): readonly DetectedWallet[] {
  start()
  return snapshot
}

/** Calls `listener` whenever the list changes. Returns an unsubscribe. */
export function subscribeDetectedWallets(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// The wallet the user last connected with, so a reload can restore it.
const SELECTED_KEY = 'cfx:wallet:selected'

export function readSelectedWalletId(): string | undefined {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function writeSelectedWalletId(id: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, id)
  } catch {
    // Storage is unavailable; the choice only lasts for this page.
  }
}

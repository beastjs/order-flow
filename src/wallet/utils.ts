import {
  createPublicClient,
  createWalletClient,
  custom,
  type Account,
  type Address,
  type Chain,
  type Transport
} from 'viem'

import type { EIP1193Provider, WalletConfig, WalletError } from './types'

export function getChain(chains: readonly Chain[], chainId: number): Chain | undefined {
  return chains.find((chain) => chain.id === chainId)
}

export function getInitialChain(config: WalletConfig): Chain {
  const chain = config.chain ?? config.chains[0]
  const configuredChain = getChain(config.chains, chain.id)

  if (!configuredChain) {
    throw new Error(`Chain ${chain.id} is not in the supported chains list.`)
  }

  return configuredChain
}

export function getTransport(config: WalletConfig, chain: Chain): Transport {
  if (config.type === 'json-rpc' && config.provider) {
    return custom(config.provider)
  }

  return config.transport(chain)
}

export function createWallet(config: WalletConfig, chain: Chain, account?: Account | Address) {
  return createWalletClient({
    account,
    chain,
    transport: getTransport(config, chain),
    name: 'Application Wallet'
  })
}

export function createPublic(config: WalletConfig, chain: Chain) {
  return createPublicClient({
    chain,
    transport: getTransport(config, chain)
  })
}

async function requestAccounts(provider: EIP1193Provider, method: string): Promise<Address[]> {
  const result = await provider.request({ method })

  return Array.isArray(result) ? (result as Address[]) : []
}

export function getProviderAccounts(provider: EIP1193Provider): Promise<Address[]> {
  return requestAccounts(provider, 'eth_accounts')
}

export function requestProviderAccounts(provider: EIP1193Provider): Promise<Address[]> {
  return requestAccounts(provider, 'eth_requestAccounts')
}

export function normalizeError(error: unknown): WalletError {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const normalized: WalletError = new Error(String(error.message))

    if ('code' in error && typeof error.code === 'number') {
      normalized.code = error.code
    }

    return normalized
  }

  return new Error(String(error))
}

export function normalizeChainId(value: unknown): number | undefined {
  try {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    }

    if (typeof value === 'string') {
      const result = Number(value.startsWith('0x') ? BigInt(value) : value)

      return Number.isSafeInteger(result) && result > 0 ? result : undefined
    }
  } catch {
    return undefined
  }

  return undefined
}

// A browser wallet stays authorized after the user disconnects in the app, so
// the choice is remembered here to stop the next refresh or reload from
// silently reconnecting.
const DISCONNECTED_KEY = 'cfx:wallet:disconnected'

export function readUserDisconnected(): boolean {
  try {
    return localStorage.getItem(DISCONNECTED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeUserDisconnected(disconnected: boolean): void {
  try {
    if (disconnected) {
      localStorage.setItem(DISCONNECTED_KEY, '1')
    } else {
      localStorage.removeItem(DISCONNECTED_KEY)
    }
  } catch {
    // Storage is unavailable; the choice only lasts for this session.
  }
}

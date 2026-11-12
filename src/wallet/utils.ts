import {
  createPublicClient,
  createWalletClient,
  custom,
  type Account,
  type Address,
  type Chain,
  type Transport
} from 'viem'

import type { EIP1193Provider, WalletConfig } from './types'

export function getChain(chains: readonly Chain[], chainId: number): Chain | undefined {
  return chains.find((chain) => chain.id === chainId)
}

export function getInitialChain(config: WalletConfig): Chain {
  const chain = config.chain ?? config.chains[0]

  if (!chain) {
    throw new Error('No supported chains configured.')
  }

  const configuredChain = getChain(config.chains, chain.id)

  if (!configuredChain) {
    throw new Error(`Chain ${chain.id} is not in the supported chains list.`)
  }

  return configuredChain
}

export function getTransport(config: WalletConfig, chain: Chain): Transport {
  if (config.type === 'local') {
    return config.transport(chain)
  }

  return custom(config.provider)
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

export async function getProviderAccounts(provider: EIP1193Provider): Promise<Address[]> {
  const result = await provider.request({
    method: 'eth_accounts'
  })

  if (!Array.isArray(result)) {
    return []
  }

  return result as Address[]
}

export async function requestProviderAccounts(provider: EIP1193Provider): Promise<Address[]> {
  const result = await provider.request({
    method: 'eth_requestAccounts'
  })

  if (!Array.isArray(result)) {
    return []
  }

  return result as Address[]
}

export function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    return new Error(String(error.message))
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

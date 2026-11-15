import { http, isHex, type Chain, type Transport } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, mainnet, polygon, sepolia } from 'viem/chains'

import type { EIP1193Provider, JsonRpcWalletConfig, LocalWalletConfig } from './types'

export const chains: readonly [Chain, ...Chain[]] = [mainnet, polygon, arbitrum, sepolia]

export const defaultChain: Chain = mainnet

function transport(chain: Chain): Transport {
  switch (chain.id) {
    case polygon.id:
      return http('https://polygon-rpc.com')
    case arbitrum.id:
      return http('https://arb1.arbitrum.io/rpc')
    default:
      return http()
  }
}

/**
 * Browser wallet. `provider` is the extension the user picked; while it is
 * undefined the session stays disconnected and `connect` rejects.
 */
export function injectedConfig(provider: EIP1193Provider | undefined): JsonRpcWalletConfig {
  return {
    type: 'json-rpc',
    provider,
    chains,
    chain: defaultChain,
    transport
  }
}

/**
 * Private-key account for local development only.
 *
 * PUBLIC_ variables are inlined into the browser bundle, so this is gated on
 * a dev build: production builds never read the key and get no local wallet.
 */
export function localConfig(): LocalWalletConfig | undefined {
  if (!import.meta.env.DEV) {
    return undefined
  }

  const key: unknown = import.meta.env.PUBLIC_WALLET_PRIVATE_KEY

  if (typeof key !== 'string' || !isHex(key)) {
    return undefined
  }

  try {
    return {
      type: 'local',
      account: privateKeyToAccount(key),
      chains,
      chain: defaultChain,
      transport
    }
  } catch {
    return undefined
  }
}

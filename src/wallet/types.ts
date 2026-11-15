import type { Account, Address, Chain, LocalAccount, Transport, WalletClient } from 'viem'

export interface EIP1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>

  on?(event: string, listener: (...args: unknown[]) => void): void

  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

/** A browser wallet extension found on the page. */
export interface DetectedWallet {
  /** Stable identifier (the extension's reverse-DNS name when it has one). */
  id: string
  name: string
  /** Inline `data:image/…` icon supplied by the extension. */
  icon?: string
  provider: EIP1193Provider
}

interface BaseWalletConfig {
  chains: readonly [Chain, ...Chain[]]
  chain?: Chain

  /**
   * Resolve the RPC transport for a particular chain.
   * Local wallets send everything through it; json-rpc wallets use it for
   * reads when no browser wallet is installed.
   */
  transport: (chain: Chain) => Transport
}

export interface JsonRpcWalletConfig extends BaseWalletConfig {
  type: 'json-rpc'

  /** Undefined until the user picks a detected browser wallet. */
  provider: EIP1193Provider | undefined
}

export interface LocalWalletConfig extends BaseWalletConfig {
  type: 'local'
  account: LocalAccount
}

export type WalletConfig = JsonRpcWalletConfig | LocalWalletConfig

export type WalletAccountType = WalletConfig['type']

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'switching-chain'

/** An Error that keeps the EIP-1193 code (e.g. 4001 = user rejected). */
export interface WalletError extends Error {
  code?: number
}

export interface WalletState {
  status: WalletStatus
  isConnected: boolean
  isConnecting: boolean
  isDisconnected: boolean
  isSwitchingChain: boolean

  account: Account | Address | undefined
  address: Address | undefined
  chain: Chain
  chainId: number
  /** Chains the app supports, for a network picker. */
  chains: readonly Chain[]

  /** False when a browser wallet is on a chain outside `chains`. */
  isChainSupported: boolean

  accountType: WalletAccountType
  availableTypes: readonly WalletAccountType[]

  /** Browser wallet extensions detected on the page. */
  wallets: readonly DetectedWallet[]
  /** The browser wallet in use, when the account type is json-rpc. */
  wallet: DetectedWallet | undefined

  /** False for json-rpc until a browser wallet has been picked. */
  hasProvider: boolean

  walletClient: WalletClient
  error: WalletError | null
}

export type WalletActions = Pick<WalletClient, 'sendTransaction' | 'signMessage' | 'signTypedData' | 'signTransaction'>

export interface WalletContextValue extends WalletState, WalletActions {
  connect(): Promise<Address>
  disconnect(): void
  reconnect(): Promise<Address | undefined>

  /** Pick a detected browser wallet and ask it to connect. */
  connectWallet(id: string): void

  /** Switch between the browser wallet and the local dev account. */
  setAccountType(type: WalletAccountType): void

  switchChain(chainId: number): Promise<void>
  refresh(): Promise<void>
  clearError(): void

  getBalance(address?: Address): Promise<bigint>
}

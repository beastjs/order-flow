import type { Account, Address, Chain, LocalAccount, Transport, WalletClient } from 'viem'

export interface EIP1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>

  on?(event: string, listener: (...args: unknown[]) => void): void

  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

interface BaseWalletConfig {
  chains: readonly [Chain, ...Chain[]]
  chain?: Chain
}

export interface JsonRpcWalletConfig extends BaseWalletConfig {
  type: 'json-rpc'
  provider: EIP1193Provider
}

export interface LocalWalletConfig extends BaseWalletConfig {
  type: 'local'
  account: LocalAccount

  /**
   * Resolve the RPC transport for a particular chain.
   * This allows local wallets to use different RPC endpoints.
   */
  transport: (chain: Chain) => Transport
}

export type WalletConfig = JsonRpcWalletConfig | LocalWalletConfig

export type WalletAccountType = 'json-rpc' | 'local'

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'switching-chain'

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
  accountType: WalletAccountType

  walletClient: WalletClient | undefined
  error: Error | null
}

export type WalletActions = Pick<WalletClient, 'sendTransaction' | 'signMessage' | 'signTypedData' | 'signTransaction'>

export type WalletSendTransaction = WalletClient['sendTransaction']

export interface WalletContextValue extends WalletState {
  connect(): Promise<Address>
  disconnect(): void
  reconnect(): Promise<Address | undefined>

  switchChain(chainId: number): Promise<void>
  refresh(): Promise<void>
  clearError(): void

  getBalance(address?: Address): Promise<bigint>

  sendTransaction: WalletActions['sendTransaction']

  signMessage: WalletActions['signMessage'] //(message: string | { raw: Hex }): Promise<Hex>
  signTypedData: WalletActions['signTypedData']
  // signTypedData<const TTypedData extends TypedData | Record<string, unknown>, TPrimaryType extends string>(parameters: {
  //   domain?: TypedDataDomain
  //   types: TTypedData
  //   primaryType: TPrimaryType
  //   message: Record<string, unknown>
  // }): Promise<Hex>
  signTransaction: WalletActions['signTransaction']
  // signTransaction(parameters: Record<string, unknown>): Promise<Hex>
}

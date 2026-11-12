import type { EIP1193Provider } from '@/wallet/types'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

export {}

import { useEffect, useState } from 'octane'
import { createPublicClient, erc20Abi, http, type Address } from 'viem'
import { PUBLIC_RPC, STABLE_DECIMALS } from '@/lib/deposits/config'

/** Explorer link for a transaction on a supported chain. */
export function explorerTx(chainId: number, hash: string): string {
  const base: Record<number, string> = {
    1: 'https://etherscan.io',
    137: 'https://polygonscan.com',
    42161: 'https://arbiscan.io',
    11155111: 'https://sepolia.etherscan.io'
  }
  return `${base[chainId] ?? 'https://etherscan.io'}/tx/${hash}`
}

/** The wallet's stablecoin balance on a chain, in USD (null while loading or unknown). */
export function useStableBalance(chainId: number | null, token: Address | null, owner: Address | undefined, refreshKey = 0): number | null {
  const [balance, setBalance] = useState<number | null>(null)
  useEffect(() => {
    setBalance(null)
    if (!chainId || !token || !owner || !PUBLIC_RPC[chainId]) return
    let alive = true
    const client = createPublicClient({ transport: http(PUBLIC_RPC[chainId], { timeout: 10_000 }) })
    client
      .readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
      .then((units) => alive && setBalance(Number(units) / 10 ** STABLE_DECIMALS))
      .catch(() => alive && setBalance(null))
    return () => {
      alive = false
    }
  }, [chainId, token, owner, refreshKey])
  return balance
}

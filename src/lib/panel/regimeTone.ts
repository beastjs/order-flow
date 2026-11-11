import { OIRegime } from '../engine/derivatives'

export function regimeTone(regime: OIRegime | undefined): 'buy' | 'sell' | 'warn' | 'muted' {
  if (regime === 'new-longs') return 'buy'
  if (regime === 'new-shorts') return 'sell'
  if (regime === 'short-covering' || regime === 'long-unwind') return 'warn'
  return 'muted'
}

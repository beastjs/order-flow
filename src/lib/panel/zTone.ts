export function zTone(z: number | null): 'sell' | 'warn' | 'accent' | 'muted' {
  if (z === null) return 'muted'
  if (z >= 3) return 'sell'
  if (z >= 2) return 'warn'
  if (z >= 1) return 'accent'
  return 'muted'
}

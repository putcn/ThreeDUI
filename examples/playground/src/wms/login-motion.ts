const CARD = { width: 885, height: 560, maxScale: 0.52, maxTilt: 0.035 } as const

export function loginScale(width: number, height: number): number {
  return Math.max(0.1, Math.min(CARD.maxScale, (height - 48) / CARD.height, (width - 40) / CARD.width))
}

export function loginTilt(x: number, y: number): [number, number, number] {
  const clamp = (n: number) => Math.max(-1, Math.min(1, n))
  const cleanZero = (n: number) => n === 0 ? 0 : n
  return [cleanZero(clamp(y) * CARD.maxTilt), cleanZero(clamp(x) * -CARD.maxTilt), 0]
}

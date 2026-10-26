import type { Settings } from '../store/settings'

export function fidelityParams(settings: Settings, size: string): Record<string, unknown> {
  const p: Record<string, unknown> = { n: 1, size }
  if (settings.image.sendFidelity) Object.assign(p, { quality: 'high', input_fidelity: 'high' })
  return p
}

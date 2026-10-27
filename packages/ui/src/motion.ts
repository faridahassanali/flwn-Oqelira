/** Component timing comes from CSS tokens, including reduced-motion behavior. */
export function timing(token: string, fallback = '--dur'): number {
  const style = getComputedStyle(document.documentElement)
  const value = style.getPropertyValue(token).trim() || style.getPropertyValue(fallback).trim()
  const number = Number.parseFloat(value)
  return Number.isFinite(number) ? number * (value.endsWith('ms') ? 1 : 1000) : 0
}
export function exitElement(element: HTMLElement): Promise<void> {
  if (!element.isConnected || typeof element.animate !== 'function') return Promise.resolve()
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  return element.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: reduce ? 'none' : 'translateY(0.25rem)' }],
    { duration: timing('--dur-fast'), easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-in').trim() },
  ).finished.then(() => {}, () => {})
}

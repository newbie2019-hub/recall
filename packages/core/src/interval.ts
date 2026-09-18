/** Human interval for the answer buttons: 10m, 3d, 2.1mo. Pure, so RN reuses it. */
export function formatInterval(fromMs: number, toMs: number): string {
  const m = Math.max(0, toMs - fromMs) / 60_000
  if (m < 1) return '<1m'
  if (m < 60) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 24) return `${Math.round(h)}h`
  const d = h / 24
  if (d < 30) return `${d < 10 ? d.toFixed(d % 1 >= 0.1 ? 1 : 0) : Math.round(d)}d`
  const mo = d / 30.44
  if (mo < 12) return `${mo.toFixed(1)}mo`
  return `${(d / 365.25).toFixed(1)}y`
}

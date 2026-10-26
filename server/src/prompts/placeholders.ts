export type PlaceholderValues = { category: string; style: string; ratio: string }

export function fillPlaceholders(text: string, v: PlaceholderValues): string {
  let out = text
  if (!v.style) {
    out = out
      .replace(/[ \t]*[·・][ \t]*\{款式\}/g, '')
      .replace(/\{款式\}[ \t]*[·・][ \t]*/g, '')
      .replace(/([ \t])?\{款式\}([ \t])?/g, (_m, a, b) => (a && b ? ' ' : ''))
  } else {
    out = out.split('{款式}').join(v.style)
  }
  return out.split('{品类}').join(v.category).split('{比例}').join(v.ratio)
}

/** 「相框·横版」；单款式只显示品类名 */
export function labelOf(category: string, style: string): string {
  return style ? `${category}·${style}` : category
}

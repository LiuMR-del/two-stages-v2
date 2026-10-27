import { TextDecoder } from 'node:util'

/**
 * 从 RTF 或粘贴的文字里取出店铺 SP-API 凭证。不依赖 macOS 的 textutil，Windows 也能用。
 * 店铺 ID 跟在「店铺ID / Seller ID / Merchant ID」后面；Client ID、Client Secret、Refresh Token 按格式认。
 */

export type SpapiCredentials = { sellerId: string | null; clientId: string | null; clientSecret: string | null; refreshToken: string | null }

/** RTF 转成纯文字：\'xx 按 GBK（或文件声明的代码页）解码，\uN 转字符，去掉控制字 */
export function rtfToText(rtf: string): string {
  if (!rtf.trimStart().startsWith('{\\rtf')) return rtf
  const cp = /\\ansicpg(\d+)/.exec(rtf)?.[1]
  const enc = cp === '936' || !cp ? 'gbk' : cp === '65001' ? 'utf-8' : `windows-${cp}`
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(enc)
  } catch {
    decoder = new TextDecoder('gbk')
  }
  const out: string[] = []
  let bytes: number[] = []
  const flush = () => {
    if (bytes.length) out.push(decoder.decode(new Uint8Array(bytes)))
    bytes = []
  }
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i]!
    if (c === '\\') {
      const next = rtf[i + 1]
      if (next === "'") {
        bytes.push(parseInt(rtf.slice(i + 2, i + 4), 16))
        i += 3
        continue
      }
      flush()
      if (next === '\\' || next === '{' || next === '}') {
        out.push(next)
        i++
        continue
      }
      if (next === '\n' || next === '\r') {
        out.push('\n')
        i++
        continue
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i))
      if (m) {
        if (m[1] === 'u' && m[2]) out.push(String.fromCharCode((Number(m[2]) + 65536) % 65536))
        else if (m[1] === 'par' || m[1] === 'line' || m[1] === 'cell' || m[1] === 'row') out.push('\n')
        i += m[0].length - 1
        continue
      }
      continue
    }
    flush()
    if (c === '{' || c === '}' || c === '\r') continue
    out.push(c)
  }
  flush()
  return out.join('')
}

/** 亚马逊各站点的 marketplaceId，长得像店铺 ID，兜底时要排除 */
const MARKETPLACE_IDS = new Set([
  'ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC', 'A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH', 'APJ6JRA9NG5V4',
  'A1RKKUPIHCS9HS', 'A1805IZSGTT6HS', 'A2NODRKZP88ZB9', 'A1C3SOZRARQ6R3', 'A33AVAJ2PDY3EV', 'A2VIGQ35RCS4UG', 'A21TJRUUN4KGV', 'A1VC38T7YXB528',
  'A39IBJ37TRP1C6', 'A19VAU5U5O7RUS', 'AMEN7PMS3EDWL', 'A17E79C6D8DWNP', 'ARBP9OOSHTCHU',
])

export function parseSpapiCredentials(input: string): SpapiCredentials {
  const text = rtfToText(input)
  const clientId = /amzn1\.application-oa2-client\.[0-9a-zA-Z]+/.exec(text)?.[0] ?? null
  const clientSecret = /amzn1\.oa2-cs\.v1\.[0-9a-zA-Z]+/.exec(text)?.[0] ?? null
  const refreshToken = /Atzr\|[A-Za-z0-9_\-|+/=]{20,}/.exec(text)?.[0] ?? null
  const labeled = /(?:店铺\s*ID|卖家\s*ID|Seller\s*ID|Merchant\s*(?:Token|ID))\s*[:：]?\s*(A[0-9A-Z]{9,19})\b/i.exec(text)?.[1]
  // 没有标签时才按格式兜底：排除站点 ID（如美国站 ATVPDKIKX0DER）和 AWS 访问密钥（AKIA…）；候选不止一个就不猜
  const loose = [...new Set(text.match(/\bA[0-9A-Z]{9,19}\b/g) ?? [])].filter((s) => /\d/.test(s) && !MARKETPLACE_IDS.has(s) && !s.startsWith('AKIA') && !s.startsWith('ASIA'))
  return { sellerId: labeled ?? (loose.length === 1 ? loose[0]! : null), clientId, clientSecret, refreshToken }
}

import { randomBytes } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function randomId(len: number): string {
  const bytes = randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i]! % ALPHABET.length]
  return s
}

export const newCategoryId = () => 'c_' + randomId(8)
export const newStyleId = () => 's_' + randomId(8)
export const newTemplateId = () => 't_' + randomId(8)

let lastStamp = ''
export function newJobId(now = Date.now()): string {
  // 定长时间戳保证字典序即创建顺序
  let stamp = now.toString(36).padStart(9, '0')
  if (stamp <= lastStamp) stamp = lastStamp
  lastStamp = stamp
  return stamp + randomId(4)
}

export function localDay(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

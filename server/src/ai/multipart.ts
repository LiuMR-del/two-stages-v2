import { randomBytes } from 'node:crypto'

export type Part = { name: string; value: string } | { name: string; filename: string; contentType: string; data: Buffer }

/**
 * 自己拼 multipart：内置 FormData 会把文本字段里的 \n 改成 \r\n，
 * 那样发出去的提示词就和界面、快照里显示的不一致了。
 */
export function encodeMultipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = '----TwoStages' + randomBytes(12).toString('hex')
  const chunks: Buffer[] = []
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(p.name)}"`
    if ('data' in p) {
      head += `; filename="${escapeQuoted(p.filename)}"\r\nContent-Type: ${p.contentType}\r\n\r\n`
      chunks.push(Buffer.from(head, 'utf8'), p.data, Buffer.from('\r\n'))
    } else {
      head += '\r\n\r\n'
      chunks.push(Buffer.from(head, 'utf8'), Buffer.from(p.value, 'utf8'), Buffer.from('\r\n'))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

function escapeQuoted(s: string): string {
  return s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

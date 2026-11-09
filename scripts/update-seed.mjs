// 把本机模版库 library/library.json 存成出厂模版 library/seed.json（进 git）。
// 只影响新装、本地还没有 library.json 的人；已经在用的同事不受影响（2026-11-09）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'library', 'library.json')
const dst = path.join(root, 'library', 'seed.json')
const lib = JSON.parse(fs.readFileSync(src, 'utf8'))
const images = path.join(root, 'library', 'images')
const missing = []
for (const c of lib.categories ?? []) {
  for (const st of c.styles ?? []) {
    for (const h of [st.whiteImage, ...(st.templates ?? []).map((t) => t.image)]) {
      if (h && !fs.readdirSync(images).some((f) => f.startsWith(h + '.'))) missing.push(`${c.name}：${h}`)
    }
  }
}
if (missing.length) {
  console.error('这些图片在 library/images 里找不到，出厂模版没更新：\n' + missing.join('\n'))
  process.exit(1)
}
fs.writeFileSync(dst, JSON.stringify(lib, null, 2) + '\n')
console.log(`已更新出厂模版 ${path.relative(root, dst)}（${lib.categories.length} 个品类）。记得把 library/images 里新加的图一起提交。`)

// 2026-10-29 加号码、首字母、队名：帆布画识别出「名字、球衣号码」，空白图却留着号码（原来只认照片、名字、日期）
const FORCE = /照片|相片|头像|合照|名字|姓名|日期|年份|纪念日|号码|编号|首字母|缩写|队名/
const BLOCK = /诗|句|文案|字体|颜色|风格/

const EN_MAP: [RegExp, string][] = [
  [/家庭姓名/, 'the family name text'],
  [/照片|相片|头像|合照/, 'the personal photo'],
  [/名字|姓名/, 'the name text'],
  [/日期|年份|纪念日/, 'the date text'],
  [/宠物/, 'the pet portrait'],
  [/球衣号/, 'the jersey number'],
  [/号码|编号/, 'the personalized number text'],
  [/首字母|缩写/, 'the personalized initials'],
  [/队名/, 'the team name text'],
]

/**
 * 模型给的 blank_items 为基础；customizable 里命中兜底词表的强制加入；命中拦截词表的一律剔除。
 * 误删诗文会毁掉整张图，漏删一个名字只是空白图不够干净，所以拦截优先。
 */
export function decideBlankItems(customizable: string[], blankItems: string[]): { zh: string[]; en: string[] } {
  const zh: string[] = []
  const add = (s: string) => {
    const t = s.trim()
    if (t && !zh.includes(t)) zh.push(t)
  }
  for (const b of blankItems) add(b)
  for (const c of customizable) if (FORCE.test(c)) add(c)
  const kept = zh.filter((s) => !BLOCK.test(s))
  const en: string[] = []
  for (const s of kept) {
    const hit = EN_MAP.find(([re]) => re.test(s))
    const v = hit ? hit[1] : s
    if (!en.includes(v)) en.push(v)
  }
  return { zh: kept, en }
}

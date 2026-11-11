/* 埋雷开关（验收文档 R-03 / R-05）：URL 带 ?break=AC-19,AC-14 就把对应实现换成坏的。
   走查 --mutate 会逐条打开，对应链路必须变红，不红说明这条检查没激活被测代码。 */
const raw = new URLSearchParams(location.search).get('break') ?? ''
export const BROKEN = new Set(raw.split(',').filter(Boolean))
export const broken = (ac: string) => BROKEN.has(ac)

/* 待审候选（还没被用户批准的方案）：默认关，URL 带 ?cand=U88 才打开。批准转正后删掉这层开关 */
const cand = new Set((new URLSearchParams(location.search).get('cand') ?? '').split(',').filter(Boolean))
export const candidate = (id: string) => cand.has(id)

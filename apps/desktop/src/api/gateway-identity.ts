/** 令牌与完整 API 地址绑定；URL 规范化只消除主机大小写、默认端口和末尾斜线。 */
export function sameGatewayBase(a: string, b: string): boolean {
  try {
    const canonical = (v: string) => new URL(v.trim()).href.replace(/\/+$/, '')
    return canonical(a) === canonical(b)
  } catch { return false }
}

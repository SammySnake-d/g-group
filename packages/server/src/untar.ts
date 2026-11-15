// 插件包解包:只认 gzip 压缩的 tar(.tgz)。自己解析 ustar / pax 头,只放行普通文件和目录:
// 绝对路径、含 .. 的路径、符号链接与硬链接、设备文件一律拒绝,不把它们写到磁盘上;解压后大小与条目数有上限。
// 不调用系统 tar,免得不同平台的 tar 对链接与路径的处理不一致。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { HostError } from "./db.ts";

export interface TarFile {
  readonly segments: readonly string[];
  readonly dir: boolean;
  readonly data: Buffer;
}

const cstr = (b: Buffer, off: number, len: number) => {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString("utf8");
};
const octal = (b: Buffer, off: number, len: number) => {
  if ((b[off]! & 0x80) !== 0) throw new HostError("invalid_params", "插件包里有超大条目(base-256 长度),不支持");
  const s = cstr(b, off, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new HostError("invalid_params", "tar 头的数字字段不是八进制");
  return s ? Number.parseInt(s, 8) : 0;
};
/** pax 扩展头:"<长度> key=value\n" 记录 */
function paxPath(data: Buffer) {
  const s = data.toString("utf8");
  let i = 0;
  let found: string | undefined;
  while (i < s.length) {
    const sp = s.indexOf(" ", i);
    if (sp < 0) break;
    const len = Number.parseInt(s.slice(i, sp), 10);
    if (!(len > 0)) break;
    const rec = s.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0 && rec.slice(0, eq) === "path") found = rec.slice(eq + 1);
    i += len;
  }
  return found;
}
function safeSegments(name: string) {
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\\")) throw new HostError("forbidden", `包里有绝对路径 ${name},不安装`);
  const segs = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) throw new HostError("forbidden", `包里有指向上级目录的路径 ${name},不安装`);
  return segs;
}

/** 解 .tgz:返回要写的文件与目录;任何不安全条目整包拒绝。 */
export function readTgz(gz: Buffer, limits: { maxBytes: number; maxEntries: number }): TarFile[] {
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) throw new HostError("invalid_params", "只支持 .tgz(gzip 压缩的 tar)插件包");
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: limits.maxBytes });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) throw new HostError("invalid_params", `插件包解压后超过 ${limits.maxBytes} 字节上限`);
    throw new HostError("invalid_params", `插件包解压失败:${(e as Error).message}`);
  }
  const out: TarFile[] = [];
  let off = 0;
  let nextPath: string | undefined;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== octal(h, 148, 8)) throw new HostError("invalid_params", "tar 头校验和不对,包已损坏");
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156]!);
    const start = off + 512;
    if (start + size > tar.length) throw new HostError("invalid_params", "tar 条目超出包末尾,包已损坏");
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "x") {
      nextPath = paxPath(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      nextPath = cstr(data, 0, data.length);
      continue;
    }
    const prefix = cstr(h, 257, 6) === "ustar" ? cstr(h, 345, 155) : "";
    const name = nextPath ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    nextPath = undefined;
    if (type === "1" || type === "2") throw new HostError("forbidden", `包里有链接条目 ${name},不安装`);
    if (type !== "0" && type !== "\0" && type !== "7" && type !== "5") throw new HostError("forbidden", `包里有不支持的条目类型 ${JSON.stringify(type)}(${name}),不安装`);
    const segments = safeSegments(name);
    if (out.length >= limits.maxEntries) throw new HostError("invalid_params", `插件包条目超过 ${limits.maxEntries} 个`);
    if (segments.length) out.push({ segments, dir: type === "5", data });
  }
  return out;
}

/** 写到 dest 下;每个目标再核一次落在 dest 里面。 */
export function extractTo(files: readonly TarFile[], dest: string) {
  for (const f of files) {
    const target = path.join(dest, ...f.segments);
    if (!target.startsWith(dest + path.sep)) throw new HostError("forbidden", `包里的路径 ${f.segments.join("/")} 落在解包目录外,不安装`);
    if (f.dir) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, f.data, { mode: 0o644 });
    }
  }
}

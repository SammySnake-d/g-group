// 自动更新:查新版 → 提示 → 下载(核对 sha512)→ 退出后替换应用并重开。
//
// 为什么不用 electron-updater:它在 macOS 上走 Squirrel.Mac,要求应用有开发者证书签名(electron-builder 文档「Code signing is
// required on macOS」);现在没有证书、应用是临时签名,Squirrel.Mac 会拒绝。所以沿用 electron-builder 产出的同一份
// latest-mac.yml 与 zip(以后有了证书可以直接换成 electron-updater,发布物不用改),替换这一步自己做:
//   1. 读 <feed>/latest-mac.yml,比版本号;
//   2. 下载对应架构的 zip,边下边算 sha512,与 yml 里的值不一致就丢掉;
//   3. ditto 解开,核对解出的应用版本号与 yml 一致、codesign --verify 通过;
//   4. 写一个小脚本:等本进程退出 → 旧应用挪开 → 新应用放回原位 → 打开新应用 → 删旧的;失败就把旧的放回去。
// 应用在只读位置(直接从 dmg 里打开、或被系统随机挪位)时不能替换,如实提示先拖进「应用程序」。
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, appendFileSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { UpdateState } from "../src/api/app-shell-types";

/** 默认更新地址:GitHub Releases 最新一版的资产目录(仓库公开,不需要令牌) */
export const DEFAULT_FEED = "https://github.com/SammySnake-d/g-group/releases/latest/download";

export interface FeedFile {
  url: string;
  sha512: string;
  size: number;
}
export interface FeedInfo {
  version: string;
  files: FeedFile[];
  releaseDate?: string;
}

/** 版本号比较:只看 x.y.z 三段数字(预发布后缀忽略) */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export function parseFeed(text: string): FeedInfo {
  const v = parse(text) as { version?: unknown; files?: unknown; releaseDate?: unknown } | null;
  if (!v || typeof v.version !== "string" || !Array.isArray(v.files)) throw new Error("更新信息格式不对(缺 version / files)");
  const files = v.files.flatMap((f: unknown) => {
    const x = f as { url?: unknown; sha512?: unknown; size?: unknown };
    return typeof x?.url === "string" && typeof x.sha512 === "string" && typeof x.size === "number" ? [{ url: x.url, sha512: x.sha512, size: x.size }] : [];
  });
  return { version: v.version, files, ...(typeof v.releaseDate === "string" ? { releaseDate: v.releaseDate } : {}) };
}

/** 选本机架构的 zip;没有带架构名的就用第一个 zip(通用包) */
export function pickZip(files: FeedFile[], arch: string): FeedFile | null {
  const zips = files.filter((f) => f.url.endsWith(".zip"));
  return zips.find((f) => f.url.includes(`-${arch}`)) ?? zips.find((f) => !/-(arm64|x64)/.test(f.url)) ?? null;
}

type Fetch = (url: string) => Promise<Response>;

export class Updater {
  private state: UpdateState;
  private feedInfo: FeedInfo | null = null;
  private zipPath: string | null = null;
  private readonly dir: string;
  private readonly log: string;

  constructor(
    private readonly o: {
      current: string;
      packaged: boolean;
      arch: string;
      userData: string;
      feed: () => string;
      fetch: Fetch;
      execPath: string;
      pid: number;
      onChange: (s: UpdateState) => void;
      quit: () => void;
    },
  ) {
    this.dir = path.join(o.userData, "updates");
    this.log = path.join(o.userData, "logs", "updater.log");
    mkdirSync(path.dirname(this.log), { recursive: true });
    this.state = { phase: "idle", current: o.current };
  }

  get(): UpdateState {
    return this.state;
  }
  private set(s: Omit<UpdateState, "current">) {
    // 下载进度每 250ms 推一次给界面,日志只记阶段变化
    if (s.phase !== this.state.phase || s.note !== this.state.note) this.note(`${s.phase}${s.latest ? ` ${s.latest}` : ""}${s.size ? ` ${s.size} 字节` : ""}${s.note ? ` · ${s.note}` : ""}`);
    this.state = { ...s, current: this.o.current };
    this.o.onChange(this.state);
  }
  private note(line: string) {
    try {
      appendFileSync(this.log, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* 写日志失败不影响更新 */
    }
  }
  private feedUrl(name: string) {
    const base = this.o.feed().replace(/\/+$/, "");
    return new URL(name, `${base}/`).toString();
  }

  /** 查一次。已经下好、正在下、正在装时不打断,直接回当前状态 */
  async check(): Promise<UpdateState> {
    if (["downloading", "ready", "installing", "checking"].includes(this.state.phase)) return this.state;
    this.set({ phase: "checking" });
    try {
      const r = await this.o.fetch(this.feedUrl("latest-mac.yml"));
      if (r.status === 404) {
        this.set({ phase: "idle", note: "还没有发布过新版本", checkedAt: new Date().toISOString() });
        return this.state;
      }
      if (!r.ok) throw new Error(`更新地址回了 ${r.status}`);
      const info = parseFeed(await r.text());
      const zip = pickZip(info.files, this.o.arch);
      if (compareVersions(info.version, this.o.current) <= 0) {
        this.set({ phase: "idle", note: "已是最新版本", checkedAt: new Date().toISOString() });
        return this.state;
      }
      if (!zip) throw new Error(`新版本 ${info.version} 没有本机(${this.o.arch})能用的安装包`);
      this.feedInfo = info;
      this.zipPath = null;
      this.set({ phase: "available", latest: info.version, size: zip.size, checkedAt: new Date().toISOString() });
    } catch (e) {
      this.set({ phase: "error", note: `检查更新失败:${message(e)}` });
    }
    return this.state;
  }

  /** 下载新版本(在后台进行,进度经 onChange 推出去) */
  download(): UpdateState {
    if (this.state.phase !== "available" && !(this.state.phase === "error" && this.feedInfo)) return this.state;
    const info = this.feedInfo!;
    const zip = pickZip(info.files, this.o.arch)!;
    void this.doDownload(info, zip).catch((e) => this.set({ phase: "error", latest: info.version, note: `下载失败:${message(e)}` }));
    return this.state;
  }

  private async doDownload(info: FeedInfo, file: FeedFile) {
    mkdirSync(this.dir, { recursive: true });
    const name = path.basename(new URL(file.url, "https://x/").pathname);
    const dest = path.join(this.dir, name);
    const part = `${dest}.part`;
    this.set({ phase: "downloading", latest: info.version, received: 0, size: file.size });
    const r = await this.o.fetch(this.feedUrl(file.url));
    if (!r.ok || !r.body) throw new Error(`下载地址回了 ${r.status}`);
    const hash = createHash("sha512");
    const out = createWriteStream(part);
    let received = 0;
    let lastPush = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) await new Promise((res) => out.once("drain", res));
      if (Date.now() - lastPush > 250) {
        lastPush = Date.now();
        this.set({ phase: "downloading", latest: info.version, received, size: file.size });
      }
    }
    await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
    const got = hash.digest("base64");
    if (got !== file.sha512) {
      rmSync(part, { force: true });
      throw new Error("下载的文件校验不通过(sha512 不一致),已丢弃");
    }
    renameSync(part, dest);
    this.zipPath = dest;
    this.note(`已下载 ${dest} ${received} 字节,sha512 一致`);
    this.set({ phase: "ready", latest: info.version, size: file.size, received });
  }

  /** 正在运行的应用包(…/g-group.app);开发模式下没有 */
  appBundle(): string | null {
    const p = path.resolve(path.dirname(this.o.execPath), "../..");
    return p.endsWith(".app") ? p : null;
  }

  /** 安装:解开、核对,写替换脚本,退出应用;脚本在应用退出后替换并重开 */
  install(): UpdateState {
    if (this.state.phase !== "ready" || !this.zipPath || !this.feedInfo) return this.state;
    const target = this.appBundle();
    if (!this.o.packaged || !target) {
      this.set({ phase: "unsupported", latest: this.feedInfo.version, note: "开发模式下不能安装更新" });
      return this.state;
    }
    if (target.startsWith("/Volumes/") || target.includes("/AppTranslocation/")) {
      this.set({ phase: "error", latest: this.feedInfo.version, note: "g-group 现在是从安装盘或临时位置打开的,先把它拖进「应用程序」文件夹再打开,然后再更新" });
      return this.state;
    }
    try {
      accessSync(path.dirname(target), constants.W_OK);
    } catch {
      this.set({ phase: "error", latest: this.feedInfo.version, note: `没有权限改 ${path.dirname(target)} 里的应用,请手动下载新版安装` });
      return this.state;
    }
    const latest = this.feedInfo.version;
    try {
      const staging = path.join(this.dir, `staging-${latest}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      execFileSync("/usr/bin/ditto", ["-x", "-k", this.zipPath, staging]);
      const appName = readdirSync(staging).find((n) => n.endsWith(".app"));
      if (!appName) throw new Error("安装包里没有找到应用");
      const fresh = path.join(staging, appName);
      const ver = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(fresh, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
      if (ver !== latest) throw new Error(`安装包里的版本是 ${ver},不是 ${latest}`);
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", fresh]);
      const script = path.join(this.dir, "swap.sh");
      writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
      const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "" };
      const child = spawn("/bin/sh", [script, String(this.o.pid), target, fresh, this.log], { detached: true, stdio: "ignore", env });
      child.unref();
      this.set({ phase: "installing", latest });
      setTimeout(() => this.o.quit(), 300);
    } catch (e) {
      this.set({ phase: "error", latest, note: `安装失败:${message(e)}` });
    }
    return this.state;
  }

  /** 清掉旧的下载与解包目录(启动时调) */
  cleanup() {
    if (!existsSync(this.dir)) return;
    for (const n of readdirSync(this.dir)) if (n.startsWith("staging-") || n.endsWith(".part")) rmSync(path.join(this.dir, n), { recursive: true, force: true });
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 替换脚本:参数 = 旧进程 pid、应用位置、新应用、日志文件 */
export const SWAP_SCRIPT = `#!/bin/sh
PID="$1"; TARGET="$2"; FRESH="$3"; LOG="$4"
exec >>"$LOG" 2>&1
echo "$(date '+%F %T') 替换脚本:等旧进程 $PID 退出"
i=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 0.2; i=$((i+1))
  if [ "$i" -gt 600 ]; then echo "旧进程两分钟没退出,放弃替换"; exit 1; fi
done
BACKUP="$TARGET.old-$$"
if ! mv "$TARGET" "$BACKUP"; then echo "挪开旧应用失败,放弃替换"; exit 1; fi
if mv "$FRESH" "$TARGET" 2>/dev/null || ditto "$FRESH" "$TARGET"; then
  rm -rf "$BACKUP"
  echo "$(date '+%F %T') 已换成新版本"
else
  rm -rf "$TARGET"; mv "$BACKUP" "$TARGET"
  echo "$(date '+%F %T') 放新版本失败,已把旧版本放回"
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
open "$TARGET"
`;

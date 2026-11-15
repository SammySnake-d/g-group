// 从访达、程序坞打开的应用拿不到登录 shell 里配的 PATH(~/.local/bin、nvm、Homebrew),Compute 要起的 claude 命令就找不到。
// 做法同 fix-path / shell-env:起一次登录交互 shell 读它的 PATH,并进当前进程;Compute 子进程按这个 PATH 找命令。
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MARK = "__GG_PATH__";

export function loginShellPath(shell = process.env.SHELL || "/bin/zsh"): string | null {
  try {
    const r = spawnSync(shell, ["-ilc", `printf '%s' "${MARK}$PATH${MARK}"`], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true", ELECTRON_RUN_AS_NODE: undefined },
    });
    const m = new RegExp(`${MARK}(.*)${MARK}`).exec(r.stdout ?? "");
    return m?.[1] || null;
  } catch {
    return null;
  }
}

/** 把登录 shell 的 PATH 和常见安装目录并进 process.env.PATH(去重,保持先后) */
export function fixPath(): void {
  if (process.platform === "win32") return;
  const fromShell = loginShellPath();
  const common = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const parts = [...(fromShell?.split(":") ?? []), ...(process.env.PATH?.split(":") ?? []), ...common];
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(":");
}

/** 在 PATH 里找可执行文件;找不到为 null */
export function which(cmd: string, envPath = process.env.PATH ?? ""): string | null {
  for (const dir of envPath.split(":")) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* 下一个目录 */
    }
  }
  return null;
}

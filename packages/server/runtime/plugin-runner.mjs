// 网络不在 Node 22 权限模型里:插件能连网,只按清单权限声明(net:fetch / net:post)告知用户,宿主没有拦。
// 协议:stdin 每行一个请求 {id, method, params},stdout 每行一个回应 {id, ok:true, result} | {id, ok:false, error}。
// 插件的 console 输出改到 stderr,stdout 只走协议;插件自己往 stdout 写非 JSON 的东西,宿主按协议违规结束进程。
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
const describeError = (e) => {
  try {
    if (e instanceof Error) return e.message || e.name;
    return typeof e === "string" ? e : JSON.stringify(e) ?? String(e);
  } catch {
    return "插件抛出了无法描述的值";
  }
};
const write = (msg) => {
  let line;
  try {
    line = JSON.stringify(msg);
  } catch (e) {
    line = JSON.stringify({ id: msg.id, ok: false, error: `结果不能转成 JSON:${describeError(e)}` });
  }
  process.stdout.write(`${line}\n`);
};
const toStderr = (...args) => {
  try {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : describeError(a))).join(" ")}\n`);
  } catch {
    /* 写不了 stderr 就丢掉 */
  }
};
for (const k of ["log", "info", "debug", "warn", "error", "trace", "dir"]) console[k] = toStderr;

let plugin = null;
async function load() {
  if (plugin === null) {
    const m = await import(pathToFileURL(entry).href);
    plugin = m.default ?? m;
  }
  return plugin;
}
const handlers = {
  async init(params) {
    const p = await load();
    if (typeof p.init === "function") await p.init(params?.config ?? null);
    const d = typeof p.describe === "function" ? await p.describe() : {};
    return { ...d, kind: p.kind };
  },
  async pull(params) {
    const p = await load();
    if (typeof p.pull !== "function") throw new Error("插件没有 pull");
    return await p.pull(params?.sourceId);
  },
  async send(params) {
    const p = await load();
    if (typeof p.send !== "function") throw new Error("插件没有 send");
    return await p.send(params?.request);
  },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const id = req?.id;
  const h = Object.hasOwn(handlers, req?.method) ? handlers[req.method] : undefined;
  if (!h) {
    write({ id, ok: false, error: `没有方法 ${String(req?.method)}` });
    return;
  }
  Promise.resolve()
    .then(() => h(req.params))
    .then(
      (result) => write({ id, ok: true, result: result === undefined ? null : result }),
      (e) => write({ id, ok: false, error: describeError(e) }),
    );
});
rl.on("close", () => process.exit(0));

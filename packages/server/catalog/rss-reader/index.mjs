// RSS 订阅(示例数据源插件)。宿主在隔离子进程里运行它:只能读本包目录,不能写文件、起子进程;
// 网络未被宿主隔离,靠清单权限 net:fetch 告知用户。
// 按配置 feeds 里的地址拉 RSS 2.0 / Atom 1.0,每个条目交一条 create 事件;条目内容或时间变了,sourceVersion 跟着变。
// 源端没给时间的条目记拉取时间。插件只交数据,盖章(来源、收到时间、不可信)由宿主做。
import { createHash } from "node:crypto";

const MAX_FEED_BYTES = 2 * 1024 * 1024;
let feeds = [];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
/** 元素的 XML 文本值:CDATA 原样保留,其余部分去掉子元素标签再解实体 */
const xmlText = (raw) => {
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    out += decode(raw.slice(last, m.index).replace(/<[^>]*>/g, " ")) + m[1];
    last = re.lastIndex;
  }
  return out + decode(raw.slice(last).replace(/<[^>]*>/g, " "));
};
/** HTML 内容(RSS 摘要、Atom type="html")再去一层 HTML 标签 */
const htmlText = (s) => decode(s.replace(/<[^>]*>/g, " "));
const squash = (s) => s.replace(/\s+/g, " ").trim();
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, "gi"))].map((m) => m[1]);
/** html: true 按 HTML 转纯文本;"auto" 看 type 属性(Atom);false 按纯文本 */
const field = (block, html, ...tags) => {
  for (const t of tags) {
    const m = new RegExp(`<${esc(t)}(\\s[^>]*)?>([\\s\\S]*?)</${esc(t)}>`, "i").exec(block);
    if (!m) continue;
    const value = xmlText(m[2]);
    const isHtml = html === "auto" ? /\btype\s*=\s*"(?:html|xhtml)"/i.test(m[1] ?? "") : html;
    return squash(isHtml ? htmlText(value) : value);
  }
  return "";
};
const atomLink = (block) => {
  for (const m of block.matchAll(/<link\b([^>]*)\/?>/gi)) {
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(m[1]);
    const rel = /\brel\s*=\s*"([^"]*)"/i.exec(m[1]);
    if (href && (!rel || rel[1] === "alternate")) return decode(href[1]);
  }
  return "";
};
const iso = (s) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export function parseFeed(xml, pulledAt) {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const items = atom ? blocks(xml, "entry") : blocks(xml, "item");
  return items.map((b) => {
    const title = field(b, atom ? "auto" : false, "title");
    const link = atom ? atomLink(b) : field(b, false, "link");
    const body = atom ? field(b, "auto", "summary", "content") : field(b, true, "description", "content:encoded");
    const when = iso(atom ? field(b, false, "updated", "published") : field(b, false, "pubDate", "dc:date")) ?? pulledAt;
    const nativeId = (atom ? field(b, false, "id") : field(b, false, "guid")) || link || title;
    const content = [title, link, body].filter(Boolean).join("\n") || "(空条目)";
    const attachments = atom ? [] : [...b.matchAll(/<enclosure\b([^>]*)\/?>/gi)].flatMap((m) => {
      const url = /\burl\s*=\s*"([^"]*)"/i.exec(m[1]);
      const type = /\btype\s*=\s*"([^"]*)"/i.exec(m[1]);
      return url ? [{ ref: decode(url[1]), ...(type ? { mime: type[1] } : {}) }] : [];
    });
    return {
      nativeId: nativeId || "(无标识)",
      sourceVersion: createHash("sha256").update(`${when}\n${content}`).digest("hex").slice(0, 16),
      eventType: "create",
      author: field(b, false, "author", "dc:creator"),
      content,
      occurredAt: when,
      attachments,
    };
  });
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`订阅内容超过 ${MAX_FEED_BYTES} 字节`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default {
  kind: "data-source",
  init(config) {
    const list = Array.isArray(config?.feeds) ? config.feeds : [];
    feeds = list.filter((f) => typeof f === "string" && /^https?:\/\//.test(f));
  },
  describe() {
    return { sources: feeds };
  },
  async pull(feed) {
    const res = await fetch(feed, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
    if (!res.ok) throw new Error(`订阅地址返回 HTTP ${res.status}`);
    return parseFeed(await readCapped(res), new Date().toISOString());
  },
};

// CSV 解析(RFC 4180),给 tasks.importCsv(US1:Helper 侧栏上传 CSV → 群任务认领板)用。不加依赖。
//   - 字段用逗号分隔,记录用 CRLF 分隔(也认单独的 LF 与 CR);
//   - 字段可用双引号包住,引号里的逗号、换行照原样保留,"" 表示一个双引号;
//   - 第一条记录是表头(必需);开头的 UTF-8 BOM 去掉;最后一条记录后的换行不算空行。
// 逐行判定:空行、列数和表头对不上记在 errors 里(带起始行号),不影响其他行;引号没闭合时从那条记录起整段报错停止。

export interface CsvRow {
  /** 这条记录在原文里的起始行号(1 起,表头是第 1 行)。 */
  readonly line: number;
  /** 按表头列名取值。 */
  readonly cells: Readonly<Record<string, string>>;
}
export interface CsvError {
  readonly line: number;
  readonly reason: string;
}
export type CsvParse =
  | { readonly ok: true; readonly header: readonly string[]; readonly rows: readonly CsvRow[]; readonly errors: readonly CsvError[] }
  | { readonly ok: false; readonly reason: string };

interface Rec {
  readonly line: number;
  readonly fields: string[];
  /** 整条记录是一个空的未加引号字段(即空行)。 */
  readonly blank: boolean;
}

/** 切成记录;引号没闭合时 broken 给出那条记录的起始行号。 */
function records(src: string): { recs: Rec[]; broken: number | null } {
  const recs: Rec[] = [];
  let fields: string[] = [];
  let field = "";
  let quotedAny = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const n = src.length;
  const endRecord = () => {
    fields.push(field);
    recs.push({ line: start, fields, blank: fields.length === 1 && fields[0] === "" && !quotedAny });
    fields = [];
    field = "";
    quotedAny = false;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '"' && field === "") {
      // 引号字段:到下一个单独的引号为止
      quotedAny = true;
      i++;
      let closed = false;
      while (i < n) {
        const d = src[i]!;
        if (d === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (d === "\r" && src[i + 1] === "\n") {
          field += "\r\n";
          i += 2;
          line++;
          continue;
        }
        if (d === "\n" || d === "\r") line++;
        field += d;
        i++;
      }
      if (!closed) return { recs, broken: start };
      // 闭合引号后应是逗号、换行或结尾;其他字符原样并入(宽松处理,不丢字)
      continue;
    }
    if (c === ",") {
      fields.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRecord();
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
      line++;
      start = line;
      continue;
    }
    field += c;
    i++;
  }
  // 结尾:最后一条记录后有换行就不再多出一条空记录
  if (field !== "" || fields.length > 0 || quotedAny) endRecord();
  return { recs, broken: null };
}

export function parseCsv(input: string): CsvParse {
  if (typeof input !== "string") return { ok: false, reason: "CSV 必须是字符串" };
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const { recs, broken } = records(src);
  const head = recs[0];
  if (!head || head.blank) return { ok: false, reason: broken === 1 ? "第 1 行的引号没有闭合" : "缺表头:第一行必须是列名" };
  const header = head.fields.map((h) => h.trim());
  if (header.some((h) => h === "")) return { ok: false, reason: "表头有空列名" };
  const dup = header.find((h, k) => header.indexOf(h) !== k);
  if (dup !== undefined) return { ok: false, reason: `表头列名重复:${dup}` };
  const rows: CsvRow[] = [];
  const errors: CsvError[] = [];
  for (const r of recs.slice(1)) {
    if (r.blank) {
      errors.push({ line: r.line, reason: "空行" });
      continue;
    }
    if (r.fields.length < header.length) {
      errors.push({ line: r.line, reason: `缺列:表头 ${header.length} 列,这行只有 ${r.fields.length} 列` });
      continue;
    }
    if (r.fields.length > header.length) {
      errors.push({ line: r.line, reason: `多列:表头 ${header.length} 列,这行有 ${r.fields.length} 列` });
      continue;
    }
    const cells: Record<string, string> = {};
    header.forEach((h, k) => {
      cells[h] = r.fields[k]!;
    });
    rows.push({ line: r.line, cells: Object.freeze(cells) });
  }
  if (broken !== null) errors.push({ line: broken, reason: "引号没有闭合,从这行起到结尾都没有导入" });
  return { ok: true, header: Object.freeze(header), rows: Object.freeze(rows), errors: Object.freeze(errors) };
}

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

/** 空壳:待实现。 */
export function parseCsv(_input: string): CsvParse {
  return { ok: false, reason: "" };
}

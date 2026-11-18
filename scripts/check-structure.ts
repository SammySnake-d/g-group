import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { lineCount, readText, reportCheck, ROOT, walkFiles } from "./governance-files.ts";

const MAX_LINES = 450;
const BASELINE = "scripts/structure-baseline.json";
const NODE_IO = /^(?:node:)?(?:fs|child_process|net|http|https|tls|worker_threads)(?:\/|$)/;
const PURE_SRC = /^packages\/(?:domain|kernel)\/src\//;

function importTarget(node: ts.Node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require"))) return node.arguments[0];
}

function checkNodeIO(file: string, source: string, issues: string[]) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    const target = importTarget(node);
    if (target && ts.isStringLiteralLike(target) && NODE_IO.test(target.text)) {
      issues.push(`${file} imports forbidden Node I/O: ${target.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

export function runStructureChecks(rootDir = ROOT, opts: { updateBaseline?: boolean } = {}): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const baselinePath = path.join(rootDir, BASELINE);
  let baseline: Record<string, number> = {};
  try {
    const parsed = JSON.parse(readText(baselinePath)).oversizedFiles as Record<string, number>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.values(parsed).some((lines) => !Number.isInteger(lines) || lines <= MAX_LINES)) {
      issues.push(`Invalid oversizedFiles in ${BASELINE}`);
    } else baseline = parsed;
  } catch {
    issues.push(`Cannot read ${BASELINE}`);
  }
  const oversized: [string, number][] = [];
  for (const dir of ["packages", "scripts"]) {
    for (const file of walkFiles(path.join(rootDir, dir))) {
      const rel = path.relative(rootDir, file).split(path.sep).join("/");
      if (dir === "packages" && /(?:\.test\.[mc]js|\.spec\.ts)$/.test(rel)) {
        issues.push(`${rel} would be skipped by the test runner; use .test.ts`);
      }
      if (!rel.endsWith(".ts") || /\.(?:test|spec)\.ts$/.test(rel)) continue;
      const source = readText(file);
      if (PURE_SRC.test(rel)) checkNodeIO(rel, source, issues);
      const lines = lineCount(source);
      if (lines <= MAX_LINES) continue;
      oversized.push([rel, lines]);
      const limit = Object.hasOwn(baseline, rel) ? baseline[rel]! : MAX_LINES;
      if (lines > limit) issues.push(`${rel} has ${lines} lines (max ${limit})`);
    }
  }

  if (opts.updateBaseline && issues.length === 0) {
    oversized.sort(([a], [b]) => a.localeCompare(b));
    fs.writeFileSync(baselinePath, `${JSON.stringify({ oversizedFiles: Object.fromEntries(oversized) }, null, 2)}\n`);
  }
  return { ok: issues.length === 0, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  reportCheck("check-structure", runStructureChecks(ROOT, { updateBaseline: process.argv.includes("--update-baseline") }));
}

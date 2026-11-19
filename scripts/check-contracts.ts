import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CONTRACT_BASELINE, entries, readText, reportCheck, ROOT, SPEC, specIds } from "./governance-files.ts";

interface Options {
  frontendDir?: string;
  checkFrontend?: boolean;
  updateBaseline?: boolean;
}

interface Baseline {
  methods: string[];
  events: string[];
  exports: string[];
  specIds: string[];
}

const CONTRACT_KEYS = ["methods", "events", "exports"] as const;
const DOTTED = /^[\w]+(?:\.[\w]+)+$/;

function unwrap(expression: ts.Expression) {
  while (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function eventTable(source: ts.SourceFile) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (!ts.isIdentifier(name) || name.text !== "ServerEvent" || !initializer) continue;
      const expression = unwrap(initializer);
      const table = ts.isCallExpression(expression)
        ? expression.arguments.map(unwrap).find(ts.isObjectLiteralExpression)
        : expression;
      if (table && ts.isObjectLiteralExpression(table)) return table;
    }
  }
}

function dottedKeys(node: ts.Node | undefined, keys: Set<string>, issues: string[], file: string) {
  if (!node) return;
  if (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) {
    const name = node.name;
    if (ts.isStringLiteral(name) && DOTTED.test(name.text)) {
      if (keys.has(name.text)) issues.push(`Duplicate contract key ${name.text} in ${file}`);
      keys.add(name.text);
    }
  }
  ts.forEachChild(node, (child) => dottedKeys(child, keys, issues, file));
}

function collectKeys(dir: string, label: string, issues: string[]) {
  const methods = new Set<string>();
  const events = new Set<string>();
  for (const entry of entries(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || /\.(?:test|spec)\.ts$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const source = ts.createSourceFile(file, readText(file), ts.ScriptTarget.Latest, true);
    if (entry.name === "events.ts") dottedKeys(eventTable(source), events, issues, file);
    else dottedKeys(source, methods, issues, file);
  }
  if (!methods.size) issues.push(`No ${label} RPC keys found at ${dir}`);
  if (!events.size) issues.push(`No ${label} ServerEvent keys found at ${dir}`);
  return { methods: [...methods].sort(), events: [...events].sort() };
}

function exportedSymbols(dir: string, issues: string[]) {
  const index = path.join(dir, "index.ts");
  // Use the checker to resolve type-only exports, aliases and transitive export stars.
  const program = ts.createProgram([index], {
    noLib: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(index);
  const module = source && checker.getSymbolAtLocation(source);
  const symbols = module ? checker.getExportsOfModule(module).map(({ name }) => name).sort() : [];
  if (!symbols.length) issues.push(`No exported contract symbols found at ${index}`);
  return symbols;
}

export function runContractChecks(rootDir = ROOT, opts: Options = {}) {
  const issues: string[] = [];
  const notes: string[] = [];
  const backend = path.join(rootDir, "packages/api-contract/src");
  const baselinePath = path.join(rootDir, CONTRACT_BASELINE);
  const keys = collectKeys(backend, "backend", issues);
  const current: Baseline = { ...keys, exports: exportedSymbols(backend, issues), specIds: specIds(readText(path.join(rootDir, SPEC))) };
  try {
    const baseline = JSON.parse(readText(baselinePath)) as Baseline;
    // The documentation gate owns spec ID validation. Preserve its snapshot when
    // refreshing the contract keys, including when using an isolated contract fixture.
    current.specIds = [...new Set([...baseline.specIds, ...current.specIds])].sort();
    for (const kind of CONTRACT_KEYS) {
      if (!Array.isArray(baseline[kind]) || !baseline[kind].length || baseline[kind].some((key) => typeof key !== "string")) {
        issues.push(`Missing or invalid baseline ${kind}`);
        continue;
      }
      const live = new Set(current[kind]);
      for (const key of baseline[kind]) {
        if (!live.has(key)) issues.push(`Removed baseline ${kind}: ${key}`);
      }
    }
  } catch {
    issues.push(`Cannot read ${CONTRACT_BASELINE}`);
  }

  const frontend = opts.frontendDir ?? path.resolve(rootDir, "../g-group-frontend/src/contracts");
  if (fs.existsSync(frontend)) {
    const fe = collectKeys(frontend, "frontend", issues);
    for (const kind of ["methods", "events"] as const) {
      const beSet = new Set(keys[kind]);
      const feSet = new Set(fe[kind]);
      const extraInFe = fe[kind].filter((key) => !beSet.has(key));
      const missingInFe = keys[kind].filter((key) => !feSet.has(key));
      if (extraInFe.length) issues.push(`Frontend ${kind} missing from backend: ${extraInFe.join(", ")}`);
      if (missingInFe.length) notes.push(`Backend ${kind} awaiting frontend wiring: ${missingInFe.join(", ")}`);
    }
  } else if (opts.checkFrontend || opts.frontendDir) {
    issues.push(`Frontend contracts not found: ${frontend}`);
  } else {
    notes.push("Sibling frontend absent. Checked the local contract baseline.");
  }

  if (opts.updateBaseline && issues.length === 0) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  }
  return { ok: issues.length === 0, issues, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const frontendDir = process.argv.find((arg) => arg.startsWith("--frontend-dir="))?.slice("--frontend-dir=".length);
  const result = runContractChecks(ROOT, {
    ...(frontendDir ? { frontendDir: path.resolve(frontendDir) } : {}),
    checkFrontend: process.argv.includes("--check-frontend"),
    updateBaseline: process.argv.includes("--update-baseline"),
  });
  reportCheck("check-contracts", result, result.notes);
}

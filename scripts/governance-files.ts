import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

export function entries(dir: string) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
}

export function* walkFiles(dir: string): Generator<string> {
  for (const entry of entries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") yield* walkFiles(full);
    if (entry.isFile()) yield full;
  }
}

export function readText(file: string) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : "";
}

export function lineCount(content: string) {
  return content === "" ? 0 : content.split(/\r?\n/).length - Number(content.endsWith("\n"));
}

export function specIds(content: string) {
  return [...new Set(content.match(/\b(?:AC|V|R)-M?\d+\b/g) ?? [])].sort();
}

export const SPEC = "docs/spec/验收文档-v0.1.md";
export const CONTRACT_BASELINE = "scripts/contract-baseline.json";

export function reportCheck(name: string, result: { ok: boolean; issues: string[] }, notes: string[] = []) {
  for (const note of notes) console.log(`[${name}] ${note}`);
  if (result.ok) console.log(`[${name}] OK`);
  else {
    for (const issue of result.issues) console.error(`[${name}] ${issue}`);
    process.exitCode = 1;
  }
}

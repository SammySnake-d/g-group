import fs from "node:fs";
import path from "node:path";
import { CONTRACT_BASELINE, entries, lineCount, readText, reportCheck, ROOT, SPEC, specIds, walkFiles } from "./governance-files.ts";

const DOCS = ["AGENTS.md", "LESSONS.md", "docs/code-standards.md", "docs/BACKEND-PROGRESS-CHECKLIST.md"];
const SUBSYSTEMS = "docs/subsystems";
const INDEX = `${SUBSYSTEMS}/README.md`;

function withoutCode(markdown: string) {
  let fence: string | undefined;
  return markdown.split("\n").filter((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = undefined;
      return false;
    }
    if (marker) fence = marker;
    return !marker && !/^(?: {4}|\t)/.test(line);
  }).join("\n").replace(/(`+)[^\n]*?\1/g, "code");
}

function checkLinks(root: string, file: string, issues: string[]) {
  const markdown = withoutCode(readText(file));
  const links = /\[[^\]\n]+\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]+|\([^()\n]*\))+))|^\s{0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]+)>|([^\s]+))/gm;
  for (const match of markdown.matchAll(links)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (/^(?:https?:\/\/|mailto:|#|file:\/\/)/i.test(raw)) continue;
    const target = raw.split(/[?#]/, 1)[0];
    if (!target) continue;
    try {
      if (fs.existsSync(path.resolve(path.dirname(file), decodeURIComponent(target)))) continue;
    } catch {
      // Report malformed encodings the same way as other invalid destinations.
    }
    issues.push(`Broken relative link in ${path.relative(root, file)}: ${raw}`);
  }
}

export function runDocChecks(rootDir = ROOT): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const rel of ["CLAUDE.md", ...DOCS, INDEX]) {
    if (!readText(path.join(rootDir, rel)).trim()) issues.push(`Missing or empty governance doc: ${rel}`);
  }
  const claude = withoutCode(readText(path.join(rootDir, "CLAUDE.md")));
  if (!/^@AGENTS\.md\s*$/m.test(claude) || !/^@LESSONS\.md\s*$/m.test(claude)) {
    issues.push("CLAUDE.md must import @AGENTS.md and @LESSONS.md");
  }
  const agentLines = lineCount(readText(path.join(rootDir, "AGENTS.md")));
  if (agentLines > 140) issues.push(`AGENTS.md has ${agentLines} lines (max 140)`);

  const subsystemDir = path.join(rootDir, SUBSYSTEMS);
  const subsystemFiles = [...walkFiles(subsystemDir)].filter((file) => file.endsWith(".md"));
  for (const file of [...DOCS, "docs/RECEIPT.md"].map((rel) => path.join(rootDir, rel)).concat(subsystemFiles)) {
    checkLinks(rootDir, file, issues);
  }
  const owned = new Set(entries(subsystemDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .flatMap(({ name }) => readText(path.join(subsystemDir, name)).match(/\bpackages\/[\w-]+/g) ?? []));
  for (const entry of entries(path.join(rootDir, "packages"))) {
    if (entry.isDirectory() && !owned.has(`packages/${entry.name}`)) {
      issues.push(`Missing owning subsystem doc for packages/${entry.name}`);
    }
  }
  const currentIds = new Set(specIds(readText(path.join(rootDir, SPEC))));
  if (currentIds.size === 0) issues.push(`Missing, empty or unnumbered acceptance spec: ${SPEC}`);
  try {
    const baseline = JSON.parse(readText(path.join(rootDir, CONTRACT_BASELINE))) as { specIds?: unknown };
    if (!Array.isArray(baseline.specIds) || baseline.specIds.length === 0 || baseline.specIds.some((id) => typeof id !== "string")) {
      issues.push(`Missing or invalid specIds in ${CONTRACT_BASELINE}`);
    } else {
      for (const id of baseline.specIds) {
        if (!currentIds.has(id)) issues.push(`Acceptance spec lost baseline ID: ${id}`);
      }
    }
  } catch {
    issues.push(`Cannot read ${CONTRACT_BASELINE}`);
  }
  return { ok: issues.length === 0, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  reportCheck("check-docs", runDocChecks());
}

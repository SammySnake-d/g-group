import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
const root = path.resolve(rootArg ? rootArg.slice("--root=".length) : process.cwd());
const policyPath = path.join(root, "scripts/comment-policy.json");
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const allowed = policy.allowedPatterns.map((pattern) => new RegExp(pattern, "i"));
const extensions = new Set(policy.extensions);
const ignoredPaths = new Set(policy.ignoredPaths);

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isCodeFile(file, rel) {
  if (ignoredPaths.has(rel)) return false;
  if (extensions.has(path.extname(file).toLowerCase())) return true;
  return policy.extensionlessRoots.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function filesUnder(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(file, result);
    else if (isCodeFile(file, relative(file))) result.push(file);
  }
  return result;
}

function addComment(comments, source, start, end) {
  const text = source.slice(start, end);
  if (!allowed.some((pattern) => pattern.test(text.trim()))) comments.push({ start, end, text });
}

function scanTypeScript(source, file) {
  const ext = path.extname(file).toLowerCase();
  const kind = ext === ".tsx" ? ts.ScriptKind.TSX : [".js", ".jsx", ".mjs", ".cjs"].includes(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map();
  const addRanges = (items) => {
    for (const range of items ?? []) ranges.set(`${range.pos}:${range.end}`, range);
  };
  const visit = (node) => {
    addRanges(ts.getLeadingCommentRanges(source, node.pos));
    addRanges(ts.getTrailingCommentRanges(source, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...ranges.values()].map(({ pos, end }) => ({ start: pos, end, text: source.slice(pos, end) }));
}

function scanBlock(source) {
  const comments = [];
  let state = "code";
  for (let i = 0; i < source.length;) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "'" || c === '"' || c === "`") {
        state = c;
        i += 1;
      } else if (c === "/" && next === "*") {
        const start = i;
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
        i = Math.min(source.length, i + 2);
        addComment(comments, source, start, i);
      } else {
        i += 1;
      }
    } else if (c === "\\") {
      i += 2;
    } else if (c === state) {
      state = "code";
      i += 1;
    } else {
      i += 1;
    }
  }
  return comments;
}

function scanHash(source) {
  const comments = [];
  let state = "code";
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (state === "code") {
      if (c === "'" || c === '"') {
        state = c;
        i += 1;
      } else if (c === "#") {
        const start = i;
        i += 1;
        while (i < source.length && source[i] !== "\n") i += 1;
        addComment(comments, source, start, i);
      } else {
        i += 1;
      }
    } else if (c === "\\") {
      i += 2;
    } else if (c === state) {
      state = "code";
      i += 1;
    } else {
      i += 1;
    }
  }
  return comments;
}

function scanHtml(source) {
  const comments = [];
  for (let start = source.indexOf("<!--"); start >= 0;) {
    const close = source.indexOf("-->", start + 4);
    const end = close < 0 ? source.length : close + 3;
    addComment(comments, source, start, end);
    start = source.indexOf("<!--", end);
  }
  return comments;
}

function scanTla(source) {
  const comments = [];
  for (let i = 0; i < source.length;) {
    const line = source.indexOf("\\*", i);
    const block = source.indexOf("(*", i);
    if (line < 0 && block < 0) break;
    if (line >= 0 && (block < 0 || line < block)) {
      const end = source.indexOf("\n", line);
      addComment(comments, source, line, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end + 1;
    } else {
      const end = source.indexOf("*)", block + 2);
      const finish = end < 0 ? source.length : end + 2;
      addComment(comments, source, block, finish);
      i = finish;
    }
  }
  return comments;
}

function scan(file) {
  const source = fs.readFileSync(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  const comments = ext === ".html" ? scanHtml(source) : ext === ".tla" ? scanTla(source) : [".py", ".sh", ".bash", ".yml", ".yaml"].includes(ext) || relative(file).startsWith(".githooks/") ? scanHash(source) : [".css", ".scss"].includes(ext) ? scanBlock(source) : scanTypeScript(source, file);
  return { source, comments };
}

function loadBaseline() {
  const file = path.join(root, policy.baseline);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data.files !== "object" || Array.isArray(data.files)) throw new Error(`Invalid comment baseline: ${policy.baseline}`);
  return data.files;
}

function main() {
  const baseline = process.argv.includes("--update-baseline") ? {} : loadBaseline();
  const current = {};
  const issues = [];
  for (const includeRoot of policy.includeRoots) {
    for (const file of filesUnder(path.join(root, includeRoot))) {
      const rel = relative(file);
      const count = scan(file).comments.length;
      current[rel] = count;
      const limit = baseline[rel] ?? 0;
      if (count > limit) issues.push(`${rel} has ${count} disallowed comments, baseline is ${limit}`);
    }
  }
  if (process.argv.includes("--update-baseline")) {
    const baselinePath = path.join(root, policy.baseline);
    fs.writeFileSync(baselinePath, `${JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`);
    console.log(`comment baseline written: ${relative(baselinePath)}`);
    return;
  }
  for (const [rel, count] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
    if (count > 0) console.log(`${rel}: ${count}`);
  }
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  } else {
    const total = Object.values(current).reduce((sum, count) => sum + count, 0);
    console.log(`comment ratchet ok: ${total} disallowed comments`);
  }
}

main();

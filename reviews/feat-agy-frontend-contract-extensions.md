# REVIEW 1: REJECT 3bb391416e6720e6f2570504b7005f5a6cc96bfeb80e4c44e026cca7eac0f635

## Round 1 — REJECT

- **PR**: `#128` (`feat/agy-frontend-contract-extensions` → `dev/agy-backend`)
- **Author**: `codex-cli:<YOUR_ACTUAL_SESSION_UUID>` (placeholder — see P1-1; `fnqtz-gpt/gpt-6.2-sol`, vendor `openai`)
- **Reviewer**: `carbon-agy` (`antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98`, `gemini-4-carbon-high`, vendor `google`)
- **Red Commit**: `38b429be32534ec23bb6690758ffb77ca212de0b`
- **Green Commit**: `d90e8539620a0a0b913f2720b09a4c273432bf61`
- **Reviewed HEAD**: `ef06b731ab0a0902778a538ac1acd8fca8ec13b4`
- **Reviewed Content Hash**: `3bb391416e6720e6f2570504b7005f5a6cc96bfeb80e4c44e026cca7eac0f635`

### 1. Blocking Defects (P1 — Mechanical Gate + Live-Reproduced Runtime Bugs)

#### P1-1: `receipts/feat-agy-frontend-contract-extensions.json` contains literal placeholder `"session": "codex-cli:<YOUR_ACTUAL_SESSION_UUID>"` (blocks `G-PROVENANCE`)
- **Location**: `receipts/feat-agy-frontend-contract-extensions.json:6`.
- **Root Cause**: `G-PROVENANCE` (`scripts/gates/gates.ts:532`) short-circuits when `receipt.review === null`, which hid the placeholder during pre-review `7/8 --local`. As soon as `review` is populated, `G-PROVENANCE` rejects `author.session` with `作者会话不可信:格式必须是 <harness>:<id>(id 只含字母、数字和 -),实际 "codex-cli:<YOUR_ACTUAL_SESSION_UUID>"`.
- **Required Fix**: Populate `author.session` with the actual `codex-cli:<uuid>` rollout session ID that authored this branch.

#### P1-2: `memory.add` (`addMemory`) corrupts manual writes on retracted-message restatement (`effective: false`) and leaks orphaned disk entries on `persona-suggestion` anchor
- **Location**: `packages/server/src/memory-api.ts:79-98`.
- **Live Reproduction Evidence (against HEAD `ef06b731`)**:
  1. **Retracted-message restatement leaves manual `memory.add` dead (`state: "source-retracted"`, `effective: false`)**:
     - `addMemory` (`memory-api.ts:92`) passes unfiltered `host.memory.listAll(p.contactId)` into `planMemoryWrite(...)`, including retracted entries (`host.memory.hiddenIds(existing)` whose `status` is still `"active"`).
     - Live repro: after retracting a DM message that produced memory `"回复风格"`, calling `memory.add` with `{ title: "回复风格", body: "永远优先给出可执行的命令与文件路径。", scope: "prefix" }` matched the retracted entry via `plan.kind === "restate"`, kept the retracted `source`, and returned `{"ok":true,"state":"source-retracted","effective":false}` — silently preventing the user's manual memory from ever entering prompt context!
  2. **`anchors: ["persona-suggestion"]` writes an invisible orphan to disk then throws `not_found`**:
     - `addMemory` writes `plan.changed` via `host.memory.put` before calling `viewOf(host, p.contactId, id)`, which filters out `PERSONA_ANCHOR` (`"persona-suggestion"`).
     - Live repro: calling `memory.add` with `anchors: ["persona-suggestion"]` persisted a new entry (`countBefore: 1 -> countAfter: 2`) and returned `{"ok":false,"error":{"code":"not_found","message":"联系人 ... 没有记忆 mem-..."}}`, leaving an undeletable orphan in `gg_memory` and `.md`.
- **Required Fix**:
  1. Exclude `hiddenIds` (retracted entries) and `PERSONA_ANCHOR` entries from `existing` before calling `planMemoryWrite` in `addMemory` (matching `Host` P1-A R2 structured capture behavior), so manual `memory.add` creates a fresh `source: null`, `effective: true` entry instead of restating a retracted quote.
  2. Reject (throw `HostError("invalid_params", ...)`) if `rawAnchors` includes `PERSONA_ANCHOR` (`"persona-suggestion"`).
  3. Add regression assertions in `packages/server/src/memory-api.test.ts` for both cases.

#### P1-3: `models.discoverGateway` falsely reports `detectedMagpie: true` for unreachable explicit remote URLs when local `~/.config/magpie/settings.json` exists, and lacks HTTP(S) `baseUrl` validation
- **Location**: `packages/server/src/magpie-discovery.ts:88-113`.
- **Live Reproduction Evidence (against HEAD `ef06b731`)**:
  - `discoverGatewayCatalog` unconditionally calls `readLocalMagpieUrl(opts.homeDir)` (`line 88`) even when `params.baseUrl` is an explicit remote URL and `params.scanLocal` is not `true`, then sets `detectedMagpie = claudeList.length > 0 || codexList.length > 0 || local.foundConfig` (`line 112`).
  - Live repro: with `~/.config/magpie/settings.json` present in `homeDir`, calling `discoverGatewayCatalog({ baseUrl: "https://remote-gateway.example.com", kind: "magpie" })` against an unreachable endpoint (`ok: false`) returned `{"source":"magpie","baseUrl":"https://remote-gateway.example.com","detectedMagpie":true,"harnesses":[],"models":[]}`.
  - Additionally, `params.baseUrl` is not validated as an `http:` / `https:` URL before `fetchFn` (`file://`, malformed URLs, or query/fragment suffixes get `/v1/models` blindly appended).
- **Required Fix**:
  1. Only consult `readLocalMagpieUrl` / `local.foundConfig` when targeting local Magpie (`!params.baseUrl?.trim()` or `params.scanLocal === true` against the local Magpie URL), never attributing local config presence to an explicit remote `baseUrl`.
  2. Validate `baseUrl` via `new URL(baseUrl)` (`protocol === "http:" || protocol === "https:"`, no credentials/invalid scheme → `HostError("invalid_params", ...)`), and if `record()` merges a model across harnesses where the first harness lacked a display label (`cur.label === cur.id`) and the second provides `entry.label`, upgrade `cur.label`.
  3. Add a regression test in `packages/server/src/magpie-discovery.test.ts`.

### 2. Non-Blocking Notes / Tightening (P2)

- **`packages/server/src/views.ts:19` & `packages/server/src/views.test.ts:14,27` (Fault `F0-F5` survived)**:
  - `views.ts` sorts `doneTasks` by `updatedAt` descending, whereas `views.test.ts` sets `createdAt: at, updatedAt: at` identically (so mutating `updatedAt` → `createdAt` in `F0-F5` survived with `0` failures). Differentiate `createdAt` vs `updatedAt` on at least one task in `views.test.ts`.
- **`packages/server/src/capabilities.ts:131-136`**:
  - Guard `n.length <= 64` (matching `CapabilityLibraryView.scripts[].name: str({ min: 1, max: 64 })` when file extensions are present) and use `statSync(full, { throwIfNoEntry: false })?.isFile()` so a broken symlink inside `library/scripts/` cannot crash `capabilities.list`.

### 3. Verified Passing Areas & Fault Injection Summary

- **Passing areas**: Strict `@g-group/api-contract` parity (`107` methods / `21` events), `typecheck` exit `0`, `lint` exit `0` (`331` files), `24/24` targeted tests passing, `recall.test.ts` `< 4000` UTF-8 bytes, and honest `"未测"` status on `AC-54` / `AC-29` / `AC-42`.
- **Single-site fault injections**:
  - `F0-F1` (`magpie-discovery.ts` `anthropic` `x-api-key` branch): **KILLED**.
  - `F0-F2` (`memory-api.ts` `scope === "prefix"` `GLOBAL_ANCHOR` mapping): **KILLED**.
  - `F0-F3` (`capabilities.ts` MCP `description` projection): **KILLED**.
  - `F0-F4` (`views.ts` `doneTasks.slice(0, 50)` cap): **KILLED**.
  - `F0-F5` (`views.ts` `updatedAt` vs `createdAt` sort key): **SURVIVED** (see P2 above).


---

# REVIEW 2: APPROVE 3014a7c367d613b28d67541ca1e7398d1963e60d648c91205a4fcc63c78301d7

## Round 2 — APPROVE

- **PR**: `#128` (`feat/agy-frontend-contract-extensions` → `dev/agy-backend`)
- **Author**: `codex-cli:01a1f0da-8e63-7d51-a2bd-316818d1943b` (`fnqtz-gpt/gpt-6.2-sol`, vendor `openai`)
- **Reviewer**: `carbon-agy` (`antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98`, `gemini-4-carbon-high`, vendor `google`)
- **Red Commit**: `e395a32a1ecf01cafa235890d8d550339e1d41d8`
- **Green Commit**: `69442f2ae8c461d4b8bde293b99cf4019a039024`
- **Reviewed HEAD**: `6a81d4388ee0abe47ab2d98a0aba946302f0ee78`
- **Reviewed Content Hash**: `3014a7c367d613b28d67541ca1e7398d1963e60d648c91205a4fcc63c78301d7`

### 1. Verification of Round 1 Fixes

1. **P1-1 RESOLVED (`receipts/feat-agy-frontend-contract-extensions.json:6`)**: `author.session` updated to real `codex-cli:01a1f0da-8e63-7d51-a2bd-316818d1943b`.
2. **P1-2 RESOLVED (`packages/server/src/memory-api.ts:86, 93-95`, `memory-api.test.ts`)**: `addMemory` rejects `PERSONA_ANCHOR` (`"persona-suggestion"`) with `invalid_params` before writing and filters `hiddenIds` + `PERSONA_ANCHOR` out of `existing` before `planMemoryWrite`, so manual re-addition of a retracted message quote creates a fresh `source: null`, `state: "active"`, `effective: true` memory.
3. **P1-3 RESOLVED (`packages/server/src/magpie-discovery.ts:46-56, 104-136`, `magpie-discovery.test.ts`)**: `gatewayUrl` validates `http:` / `https:` without embedded credentials, `readLocalMagpieUrl` / `local.foundConfig` is restricted to `targetsLocal`, and `record()` upgrades `cur.label` when merging across harnesses.
4. **P2 RESOLVED (`packages/server/src/views.test.ts:26-38`, `capabilities.ts:132,135`)**: `views.test.ts` differentiates `createdAt` vs `updatedAt` (**`F0-R2-F5` `updatedAt -> createdAt` mutation now KILLED**), and `capabilities.ts` skips `n.length > 64` script names and broken symlinks (`statSync(..., { throwIfNoEntry: false })?.isFile()`).

### 2. Independent Verification

- `npm run typecheck`: exit `0`; `npm run lint`: exit `0` (`331` files, `0` diagnostics).
- Targeted test suites (`capabilities.test.ts`, `magpie-discovery.test.ts`, `memory-api.test.ts`, `views.test.ts`): **`30/30` passed**.
- Live Round 2 repro script + `F0-R2-F5` fault injection: all passed (`R2_REPRO_VERIFIED_ALL_FIXED=true`, `F0-R2-F5 killed=True`).
- `AC-54`, `AC-29`, and `AC-42` remain honestly marked `"未测"` pending frontend UI and P3 verification.

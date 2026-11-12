// U07 配置历史。只保存明确的配置字段;身份、记忆、任务和运行状态独立。
import type { ContactConfig, ContactConfigVersion } from "@g-group/api-contract";
import { type Db, HostError, all, listDocs, one, run, tx } from "./db.ts";

type ConfigSource = Omit<ContactConfig, "computeSlots"> & { readonly computeSlots?: number | null };

/** 显式投影而不是拷贝整个联系人文档;凭据值、记忆和运行时字段不能混进快照。 */
export function contactConfigOf(value: ConfigSource): ContactConfig {
  const model = value.computeModel;
  return {
    name: value.name, avatar: value.avatar, bio: value.bio,
    speakingModel: value.speakingModel, harness: value.harness,
    computeModel: { mode: model.mode, ...(model.model !== undefined ? { model: model.model } : {}), ...(model.effort !== undefined ? { effort: model.effort } : {}) },
    tools: [...value.tools], computeAssets: value.computeAssets.map(({ name, kind }) => ({ name, kind })),
    computeSlots: value.computeSlots ?? null, persona: value.persona,
  };
}

export function installContactHistory(db: Db, now: string) {
  db.store.db.exec(`CREATE TABLE IF NOT EXISTS gg_contact_config_versions (
    contact_id TEXT NOT NULL, version INTEGER NOT NULL, config TEXT NOT NULL,
    kind TEXT NOT NULL, restored_from INTEGER, at TEXT NOT NULL,
    PRIMARY KEY (contact_id, version)
  );
  CREATE TRIGGER IF NOT EXISTS gg_contact_config_no_overwrite BEFORE INSERT ON gg_contact_config_versions
    WHEN EXISTS (SELECT 1 FROM gg_contact_config_versions WHERE contact_id = NEW.contact_id AND version = NEW.version)
    BEGIN SELECT RAISE(ABORT, 'contact config history immutable'); END;
  CREATE TRIGGER IF NOT EXISTS gg_contact_config_no_update BEFORE UPDATE ON gg_contact_config_versions BEGIN SELECT RAISE(ABORT, 'contact config history immutable'); END;
  CREATE TRIGGER IF NOT EXISTS gg_contact_config_no_delete BEFORE DELETE ON gg_contact_config_versions BEGIN SELECT RAISE(ABORT, 'contact config history immutable'); END;
  CREATE TABLE IF NOT EXISTS gg_contact_config_actions (
    contact_id TEXT NOT NULL, action_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY (contact_id, action_id)
  );`);
  // 升级时只有当前值是已知事实。不补造版本 1..N,不覆盖已有记录。
  tx(db, () => {
    for (const row of listDocs<ConfigSource & { id: string; removed?: boolean }>(db, "contact:")) {
      if (row.value.removed || one(db, "SELECT 1 FROM gg_contact_config_versions WHERE contact_id = ? LIMIT 1", row.value.id)) continue;
      recordContactConfig(db, row.value.id, row.ver, row.value, "baseline", now);
    }
  });
}

export function recordContactConfig(db: Db, id: string, version: number, value: ConfigSource, kind: ContactConfigVersion["kind"], at: string, restoredFrom: number | null = null) {
  void [db, id, version, value, kind, at, restoredFrom];
}

type VersionRow = { version: number; config: string; kind: ContactConfigVersion["kind"]; restored_from: number | null; at: string };
const view = (row: VersionRow): ContactConfigVersion => ({ version: row.version, config: contactConfigOf(JSON.parse(row.config) as ConfigSource), kind: row.kind, restoredFrom: row.restored_from, at: row.at });

export function contactVersions(db: Db, id: string, query: { beforeVersion?: number; limit?: number }) {
  const limit = query.limit ?? 50;
  const rows = all<VersionRow>(db, "SELECT * FROM gg_contact_config_versions WHERE contact_id = ? AND version < ? ORDER BY version DESC LIMIT ?", id, query.beforeVersion ?? Number.MAX_SAFE_INTEGER, limit + 1);
  return { versions: rows.slice(0, limit).map(view), hasMore: rows.length > limit };
}

export function contactVersion(db: Db, id: string, version: number): ContactConfigVersion {
  const row = one<VersionRow>(db, "SELECT * FROM gg_contact_config_versions WHERE contact_id = ? AND version = ?", id, version);
  if (!row) throw new HostError("not_found", `联系人 ${id} 没有配置版本 ${version}`);
  return view(row);
}

/** 请求身份不依赖 JSON 属性顺序。只接受来自参数合同的 JSON 数据。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function replayConfigAction<T>(db: Db, contactId: string, actionId: string | undefined, request: unknown): { result: T } | null {
  if (actionId === undefined) return null;
  const row = one<{ request: string; result: string }>(db, "SELECT request, result FROM gg_contact_config_actions WHERE contact_id = ? AND action_id = ?", contactId, actionId);
  if (!row) return null;
  if (row.request !== canonical(request)) throw new HostError("conflict", "同一配置动作号已用于不同请求");
  return { result: JSON.parse(row.result) as T };
}

export function rememberConfigAction(db: Db, contactId: string, actionId: string | undefined, request: unknown, result: unknown) {
  if (actionId === undefined) return;
  run(db, "INSERT INTO gg_contact_config_actions (contact_id, action_id, request, result) VALUES (?, ?, ?, ?)", contactId, actionId, canonical(request), JSON.stringify(result));
}

// U07 配置历史。只保存明确的配置字段;身份、记忆、任务和运行状态独立。
import type { Db } from "./db.ts";

export function installContactHistory(db: Db) {
  db.store.db.exec(`CREATE TABLE IF NOT EXISTS gg_contact_config_versions (
    contact_id TEXT NOT NULL, version INTEGER NOT NULL, config TEXT NOT NULL,
    kind TEXT NOT NULL, restored_from INTEGER, at TEXT NOT NULL,
    PRIMARY KEY (contact_id, version)
  );`);
}

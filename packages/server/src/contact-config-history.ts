import type { Db } from "./db.ts";

/** Red fixture schema only. No contact write records history yet. */
export function installContactHistory(db: Db, _now: string) {
  db.store.db.exec(`CREATE TABLE IF NOT EXISTS gg_contact_config_versions (
    contact_id TEXT NOT NULL, version INTEGER NOT NULL, config TEXT NOT NULL,
    kind TEXT NOT NULL, restored_from INTEGER, at TEXT NOT NULL,
    PRIMARY KEY (contact_id, version)
  )`);
}

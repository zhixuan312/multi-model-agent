-- Phase A0 schema version 1 (verbatim from `packages/core/src/initiative-record/migrations.ts`
-- migration version 1 at HEAD), seeded with at least one representative row in
-- EVERY version-1 table (AC-1.9). `tests/initiative-record/a1-migration-v2.check.test.ts`
-- loads this fixture, applies two extra rows (a Product and an Initiative,
-- kept in the test file itself so the fixture stays a pure schema+seed file),
-- stamps `PRAGMA user_version = 1`, then runs `runInitiativeMigrations` and
-- asserts every one of these tables still has >= 1 row after the additive
-- upgrade to version 2.

CREATE TABLE IF NOT EXISTS products (
  uuid       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  uuid        TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(uuid),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  revision    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_product_id ON workspaces(product_id);

CREATE TABLE IF NOT EXISTS resources (
  uuid               TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(uuid),
  type               TEXT NOT NULL,
  canonical_locator  TEXT NOT NULL,
  local_path         TEXT,
  description        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  revision           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_workspace_id ON resources(workspace_id);

CREATE TABLE IF NOT EXISTS initiatives (
  uuid       TEXT PRIMARY KEY,
  human_key  TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL REFERENCES products(uuid),
  title      TEXT NOT NULL,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL,
  outcome    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_initiatives_product_id ON initiatives(product_id);

CREATE TABLE IF NOT EXISTS initiative_workspace_links (
  initiative_id TEXT NOT NULL REFERENCES initiatives(uuid),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(uuid),
  role          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  PRIMARY KEY (initiative_id, workspace_id, role)
);

CREATE TABLE IF NOT EXISTS initiative_relations (
  from_id    TEXT NOT NULL REFERENCES initiatives(uuid),
  to_id      TEXT NOT NULL REFERENCES initiatives(uuid),
  type       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS idx_initiative_relations_to_id ON initiative_relations(to_id);

CREATE TABLE IF NOT EXISTS tasks (
  uuid            TEXT PRIMARY KEY,
  initiative_id   TEXT NOT NULL REFERENCES initiatives(uuid),
  title           TEXT NOT NULL,
  goal            TEXT NOT NULL,
  status          TEXT NOT NULL,
  outcome         TEXT,
  workspace_ids   TEXT NOT NULL,
  resource_ids    TEXT NOT NULL,
  execution_refs  TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  revision        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_initiative_id ON tasks(initiative_id);

CREATE TABLE IF NOT EXISTS artifact_refs (
  uuid              TEXT PRIMARY KEY,
  initiative_id     TEXT NOT NULL REFERENCES initiatives(uuid),
  storage_mode      TEXT NOT NULL,
  path_or_uri       TEXT NOT NULL,
  content_hash      TEXT,
  media_type        TEXT,
  version           TEXT,
  produced_by_task  TEXT,
  description       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  UNIQUE (initiative_id, path_or_uri)
);

CREATE TABLE IF NOT EXISTS events (
  event_sequence INTEGER PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  initiative_id  TEXT,
  event_type     TEXT NOT NULL,
  payload        TEXT NOT NULL,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  interface      TEXT NOT NULL,
  initiated_by   TEXT NOT NULL,
  authorized_by  TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  source         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_initiative_id ON events(initiative_id);

CREATE TABLE IF NOT EXISTS idempotency_results (
  operation       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters (name, value) VALUES ('initiative_human_key', 1);

-- Seed rows: one representative row per version-1 table, using a distinct
-- `aaaaaaaa-...` UUID range and `MMA-INIT-9xx` human keys so nothing here
-- collides with the check test's own separate Product (uuid
-- `...0001`) and Initiative (uuid `...0002`, human_key `MMA-INIT-001`)
-- inserts, which run against this same database right after this fixture
-- loads.
INSERT INTO products (uuid, name, slug, created_at, updated_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'Fixture Product', 'fixture-product', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);

INSERT INTO workspaces (uuid, product_id, name, slug, description, created_at, updated_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'W', 'w', 'workspace', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);

INSERT INTO resources (uuid, workspace_id, type, canonical_locator, local_path, description, created_at, updated_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000002', 'repo', 'repo://x', NULL, 'resource', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);

INSERT INTO initiatives (uuid, human_key, product_id, title, goal, status, outcome, created_at, updated_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000004', 'MMA-INIT-900', 'aaaaaaaa-0000-4000-8000-000000000001', 'Fixture I', 'G', 'open', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);
INSERT INTO initiatives (uuid, human_key, product_id, title, goal, status, outcome, created_at, updated_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000005', 'MMA-INIT-901', 'aaaaaaaa-0000-4000-8000-000000000001', 'Fixture I2', 'G2', 'open', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);

INSERT INTO initiative_workspace_links (initiative_id, workspace_id, role, created_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000002', 'primary', '2026-01-01T00:00:00.000Z', 0);

INSERT INTO initiative_relations (from_id, to_id, type, created_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000005', 'related', '2026-01-01T00:00:00.000Z', 0);

INSERT INTO tasks (uuid, initiative_id, title, goal, status, outcome, workspace_ids, resource_ids, execution_refs, created_at, updated_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000004', 'T', 'g', 'open', NULL, '[]', '[]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);

INSERT INTO artifact_refs (uuid, initiative_id, storage_mode, path_or_uri, content_hash, media_type, version, produced_by_task, description, created_at, updated_at, revision)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000004', 'inline', 'file://x', NULL, NULL, NULL, NULL, 'artifact', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);

INSERT INTO events (entity_type, entity_id, initiative_id, event_type, payload, actor_type, actor_id, interface, initiated_by, authorized_by, timestamp, source)
  VALUES ('Initiative', 'aaaaaaaa-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000004', 'initiative_created', '{}', 'human', 'u', 'http', 'u', 'u', '2026-01-01T00:00:00.000Z', 'seed');

INSERT INTO idempotency_results (operation, idempotency_key, request_hash, result_json, created_at)
  VALUES ('initiative_create', 'fixture-seed-key', 'fixture-seed-hash', '{}', '2026-01-01T00:00:00.000Z');

// db.js — SQLite (sql.js/WASM) living entirely in the browser, with the
// database file persisted as a byte blob in IndexedDB.

const IDB_NAME = 'habits-store';
const IDB_STORE = 'files';
const IDB_KEY = 'habits.db';
const SCHEMA_VERSION = 3;

let SQL = null;   // the sql.js module
let db = null;    // the open Database
let saving = null;   // in-flight export, if any
let dirty = false;   // a write landed while an export was in flight

/* ---------- IndexedDB blob storage ---------- */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const conn = await idb();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => conn.close();
  });
}

async function idbPut(key, value) {
  const conn = await idb();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => { conn.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- schema ---------- */

const MIGRATIONS = [
  // index 0 -> brings user_version from 0 to 1
  `
  CREATE TABLE habits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    kind          TEXT    NOT NULL CHECK (kind IN ('time','count')),
    weekly_budget REAL    NOT NULL,
    unit          TEXT,
    color         TEXT    NOT NULL DEFAULT '#5b8def',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    amount     REAL    NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    note       TEXT
  );
  CREATE INDEX entries_habit_started ON entries(habit_id, started_at);

  -- A row here means a timer is currently running for that habit. Surviving
  -- in the database is what lets a timer outlive the tab being closed.
  CREATE TABLE timers (
    habit_id   INTEGER PRIMARY KEY REFERENCES habits(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `,

  // index 1 -> 2: allow the 'money' kind. A CHECK constraint cannot be altered
  // in SQLite, so the table is rebuilt. Foreign keys are disabled for the
  // duration: DROP TABLE fires ON DELETE CASCADE, which would take every
  // entry and timer with it.
  `
  PRAGMA foreign_keys = OFF;

  CREATE TABLE habits_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    kind          TEXT    NOT NULL CHECK (kind IN ('time','count','money')),
    weekly_budget REAL    NOT NULL,
    unit          TEXT,
    color         TEXT    NOT NULL DEFAULT '#5b8def',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  INSERT INTO habits_new (id, name, kind, weekly_budget, unit, color, sort_order, archived, created_at)
    SELECT id, name, kind, weekly_budget, unit, color, sort_order, archived, created_at FROM habits;

  DROP TABLE habits;
  ALTER TABLE habits_new RENAME TO habits;

  PRAGMA foreign_keys = ON;
  `,

  // index 2 -> 3: an optional per-day limit alongside the weekly budget.
  // NULL means the habit has no daily limit, which is what every existing
  // row gets, so the column can simply be appended.
  `
  ALTER TABLE habits ADD COLUMN daily_limit REAL;
  `,
];

function migrate() {
  let version = db.exec('PRAGMA user_version')[0].values[0][0];
  while (version < SCHEMA_VERSION) {
    db.run(MIGRATIONS[version]);
    version += 1;
    db.run(`PRAGMA user_version = ${version}`);
  }
}

/* ---------- lifecycle ---------- */

export async function open() {
  if (db) return db;
  SQL = await initSqlJs({ locateFile: (f) => `vendor/${f}` });
  const bytes = await idbGet(IDB_KEY);
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  migrate();
  if (!bytes) await save();
  return db;
}

// Persists immediately rather than on a debounce: a phone can be swiped away
// a fraction of a second after a tap, and a pending write would be lost.
// Concurrent calls collapse into at most one queued follow-up export.
export function save() {
  if (saving) {
    dirty = true;
    return saving;
  }
  saving = (async () => {
    try {
      do {
        dirty = false;
        await idbPut(IDB_KEY, db.export());
      } while (dirty);
    } finally {
      saving = null;
    }
  })();
  return saving;
}

// Flush and wait — used when the page is being hidden or unloaded.
export async function saveNow() {
  dirty = true;
  await save();
}

/* ---------- query helpers ---------- */

export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export function one(sql, params = []) {
  return all(sql, params)[0] || null;
}

export function run(sql, params = []) {
  db.run(sql, params);
  save();
}

export function lastInsertId() {
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

/* ---------- backup ---------- */

export function exportBytes() {
  return db.export();
}

export async function importBytes(bytes) {
  const incoming = new SQL.Database(new Uint8Array(bytes));
  // Fail before touching the live database if the file isn't one of ours.
  incoming.exec('SELECT id, name, kind, weekly_budget FROM habits LIMIT 1');
  if (db) db.close();
  db = incoming;
  db.run('PRAGMA foreign_keys = ON');
  migrate();
  await saveNow();
}

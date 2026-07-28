// src/db.js
// Database connection + schema. The only file that knows about storage.
//
// libSQL (the SQLite fork behind Turso) rather than a local SQLite file, because
// this deploys to Vercel. Vercel's filesystem is read-only apart from an
// ephemeral /tmp, so a file-backed database cannot persist between invocations —
// the record registered on call 1 would be gone by call 2. libSQL keeps the
// SQLite dialect (same CHECK constraints, same strftime, same SQL) while moving
// the storage over the network.
//
// One connection string covers both environments:
//   local dev / tests   DATABASE_URL=file:./data/patients.db   (no account needed)
//   production          DATABASE_URL=libsql://<db>.turso.io    + DATABASE_AUTH_TOKEN
//
// Everything here is async, unlike a synchronous file driver. That's the reason
// the service layer is async too.

const RAW_URL = process.env.DATABASE_URL || "file:./data/patients.db";
const AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;

const isRemote = /^(libsql|https?|wss?):/i.test(RAW_URL);

// Local `file:` URLs need the native driver; remote URLs are served over plain
// HTTP by `@libsql/client/web`, which has no native binary at all. Importing the
// web build in production keeps the serverless bundle small and sidesteps any
// platform-specific prebuild question on Vercel's runtime.
const { createClient } = isRemote
  ? await import("@libsql/client/web")
  : await import("@libsql/client");

// A file: database still needs its directory to exist.
if (!isRemote) {
  const { mkdirSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const filePath = RAW_URL.replace(/^file:/, "");
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

export const client = createClient({
  url: RAW_URL,
  ...(AUTH_TOKEN ? { authToken: AUTH_TOKEN } : {}),
});

/** Human-readable description of where data is going, for /health and preflight. */
export const DB_DESCRIPTION = isRemote ? RAW_URL.replace(/\?.*$/, "") : `${RAW_URL} (local file)`;
export const IS_REMOTE = isRemote;

// --- Query helpers ---------------------------------------------------------
// libSQL returns array-like Row objects; these hand back plain objects so
// nothing downstream has to care which driver produced them.

const toPlain = (row) => ({ ...row });

export async function query(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows.map(toPlain);
}

export async function get(sql, args = []) {
  const rows = await query(sql, args);
  return rows[0] ?? null;
}

export async function run(sql, args = []) {
  const result = await client.execute({ sql, args });
  return { rowsAffected: result.rowsAffected };
}

// --- Schema ----------------------------------------------------------------
// Constraints are enforced in the database as well as in src/validation.js. The
// double-check is deliberate: the voice agent and the REST API are two separate
// front doors, and neither is trusted to be the only guard.
//
// Storage formats (normalized on the way in, see src/validation.js):
//   date_of_birth  ISO 'YYYY-MM-DD'  — sortable and range-queryable. Spoken and
//                                      rendered as MM/DD/YYYY.
//   phone_number   10 bare digits    — so lookups match regardless of how the
//                                      caller or an API client formatted it.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS patients (
    patient_id              TEXT PRIMARY KEY,
    first_name              TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 50),
    last_name               TEXT NOT NULL CHECK (length(last_name)  BETWEEN 1 AND 50),
    date_of_birth           TEXT NOT NULL CHECK (date_of_birth IS strftime('%Y-%m-%d', date_of_birth)),
    sex                     TEXT NOT NULL CHECK (sex IN ('Male', 'Female', 'Other', 'Decline to Answer')),
    phone_number            TEXT NOT NULL CHECK (length(phone_number) = 10),
    email                   TEXT,
    address_line_1          TEXT NOT NULL CHECK (length(address_line_1) BETWEEN 1 AND 200),
    address_line_2          TEXT,
    city                    TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
    state                   TEXT NOT NULL CHECK (length(state) = 2),
    zip_code                TEXT NOT NULL CHECK (length(zip_code) IN (5, 10)),
    insurance_provider      TEXT,
    insurance_member_id     TEXT,
    preferred_language      TEXT NOT NULL DEFAULT 'English',
    emergency_contact_name  TEXT,
    emergency_contact_phone TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    deleted_at              TEXT
  )`,

  // Cover the three documented GET /patients filters plus the duplicate-detection
  // lookup the voice agent runs on every call.
  `CREATE INDEX IF NOT EXISTS idx_patients_phone     ON patients (phone_number)`,
  `CREATE INDEX IF NOT EXISTS idx_patients_last_name ON patients (last_name)`,
  `CREATE INDEX IF NOT EXISTS idx_patients_dob       ON patients (date_of_birth)`,

  // Call transcripts/summaries. This table also carries the call -> patient link
  // *during* the call: a serverless function can't hold that in memory, because
  // the next tool call may land on a different instance.
  `CREATE TABLE IF NOT EXISTS calls (
    call_id       TEXT PRIMARY KEY,
    patient_id    TEXT REFERENCES patients (patient_id) ON DELETE SET NULL,
    ended_reason  TEXT,
    summary       TEXT,
    transcript    TEXT,
    created_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calls_patient ON calls (patient_id)`,

  // Booked appointments (the optional scheduling bonus). slot_id is the primary
  // key and encodes date+time, so the database itself prevents two callers being
  // given the same slot — no in-memory bookkeeping, which wouldn't survive
  // serverless anyway.
  `CREATE TABLE IF NOT EXISTS appointments (
    slot_id       TEXT PRIMARY KEY,
    confirmation  TEXT NOT NULL UNIQUE,
    slot_date     TEXT NOT NULL,
    slot_time     TEXT NOT NULL,
    provider      TEXT NOT NULL,
    patient_id    TEXT REFERENCES patients (patient_id) ON DELETE SET NULL,
    patient_name  TEXT,
    created_at    TEXT NOT NULL
  )`,
];

/**
 * Create the schema if it isn't there. Memoized, so it costs one round trip per
 * process (i.e. once per serverless cold start) rather than one per request, and
 * concurrent callers share the same in-flight promise.
 *
 * Also run explicitly by `npm run migrate` against a fresh Turso database.
 */
let migration = null;

export function migrate() {
  migration ??= client
    .batch(SCHEMA, "write") // one network round trip for the whole schema
    .catch((err) => {
      migration = null; // let a later request retry rather than poisoning the process
      throw err;
    });
  return migration;
}

// node:sqlite and libSQL both reject `undefined` bindings (null, number, string,
// bigint and Uint8Array are accepted). Every optional field has to be coerced
// before it reaches a statement — forgetting this is the easiest way to crash a
// write mid-call, so all binding goes through here.
export function toBinding(value) {
  return value === undefined || value === "" ? null : value;
}

export function nowIso() {
  return new Date().toISOString();
}

export function closeDb() {
  try {
    client.close();
  } catch {
    /* already closed, or a remote client with nothing to close */
  }
}

// src/db.js
// Database connection + schema. The only file that knows about storage.
//
// MongoDB Atlas. The brief allows any relational or document database, and Atlas
// is a managed network database — which is what Vercel requires. Vercel's
// filesystem is read-only apart from an ephemeral /tmp, so a file-backed database
// there would lose every record between invocations: the patient registered on
// call 1 would be gone by call 2.
//
// Two things this file is careful about, both learned the hard way:
//
// 1. NO I/O AT IMPORT TIME. An earlier version created its data directory during
//    module load, so a missing connection string threw while the module was being
//    imported — which took down *every* route, including /health and static
//    assets, with an opaque ENOENT. Connection setup is lazy, so a
//    misconfiguration is reported by the routes that need the database and
//    everything else keeps serving.
//
// 2. ONE CACHED CLIENT PER PROCESS. A fresh MongoClient per invocation would
//    exhaust Atlas's connection limit under load, because each serverless
//    instance opens its own pool. The client promise is memoized at module scope
//    so a warm instance reuses its connection.

import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI || process.env.DATABASE_URL || "";

// Database name: explicit env var wins, otherwise the path in the URI, otherwise
// a sensible default. Atlas SRV strings frequently omit the database entirely.
function databaseNameFromUri(uri) {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
  return match?.[1] || null;
}

const DB_NAME = process.env.MONGODB_DB || databaseNameFromUri(URI) || "carecloud";

/**
 * A configuration mistake detected up front so it can be reported rather than
 * discovered as a crash. Surfaced by /health and scripts/preflight.js.
 *
 * There is deliberately no local fallback: silently defaulting to some other
 * store is how you end up with a deployment that looks healthy and quietly loses
 * data.
 */
export const CONFIG_ERROR = !URI
  ? "MONGODB_URI is not set. Set it to your MongoDB Atlas connection string " +
    "(mongodb+srv://...) in .env locally, and in the host's environment variables in production."
  : null;

/** Human-readable, credential-free description for /health and preflight. */
export const DB_DESCRIPTION = URI
  ? `mongodb://${URI.replace(/^mongodb(\+srv)?:\/\//i, "").replace(/^[^@]*@/, "").replace(/[/?].*$/, "")}/${DB_NAME}`
  : "(not configured)";

export const IS_REMOTE = true;

// --- Lazy, cached connection ----------------------------------------------

let clientPromise = null;

function getClient() {
  if (CONFIG_ERROR) return Promise.reject(new Error(CONFIG_ERROR));

  clientPromise ??= MongoClient.connect(URI, {
    // Keep the pool small: every serverless instance has its own, and Atlas's
    // free tier caps total connections.
    maxPoolSize: 10,
    // Fail fast rather than hanging a phone call for 30 seconds on a bad URI.
    serverSelectionTimeoutMS: 8000,
  }).catch((err) => {
    clientPromise = null; // let a later request retry instead of poisoning the process
    throw err;
  });

  return clientPromise;
}

export async function db() {
  const client = await getClient();
  return client.db(DB_NAME);
}

/** Collection handles, after ensuring indexes and validators exist. */
export async function collection(name) {
  await migrate();
  return (await db()).collection(name);
}

/** True if the database is reachable. Used by /health without throwing. */
export async function ping() {
  try {
    await (await db()).command({ ping: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Schema ----------------------------------------------------------------
// MongoDB is schemaless by default, which would leave src/validation.js as the
// only guard. That's not enough here: the voice agent and the REST API are two
// separate front doors, and neither should be trusted as the sole gatekeeper. So
// the shape is enforced in the database too, via $jsonSchema validators.
//
// Storage formats (normalized on the way in, see src/validation.js):
//   date_of_birth  ISO 'YYYY-MM-DD'  — sortable and range-queryable. Spoken and
//                                      rendered as MM/DD/YYYY.
//   phone_number   10 bare digits    — so lookups match regardless of how the
//                                      caller or an API client formatted it.
//
// Honest limitation: a regex can enforce that date_of_birth *looks* like
// YYYY-MM-DD, but not that it is a real calendar date — '1990-02-30' matches the
// pattern. The SQL version of this schema could reject it outright with
// CHECK (date_of_birth IS strftime(...)). src/validation.js still catches it by
// round-tripping through a Date, so invalid dates cannot get in through either
// front door; the difference is that the database is no longer a second line of
// defence for that one rule.

const nullableString = (extra = {}) => ({ bsonType: ["string", "null"], ...extra });

const PATIENT_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "patient_id", "first_name", "last_name", "date_of_birth", "sex",
      "phone_number", "address_line_1", "city", "state", "zip_code",
      "preferred_language", "created_at", "updated_at",
    ],
    properties: {
      patient_id: { bsonType: "string", pattern: "^[0-9a-f-]{36}$" },
      first_name: { bsonType: "string", minLength: 1, maxLength: 50 },
      last_name: { bsonType: "string", minLength: 1, maxLength: 50 },
      date_of_birth: { bsonType: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      sex: { enum: ["Male", "Female", "Other", "Decline to Answer"] },
      phone_number: { bsonType: "string", pattern: "^\\d{10}$" },
      email: nullableString({ maxLength: 254 }),
      address_line_1: { bsonType: "string", minLength: 1, maxLength: 200 },
      address_line_2: nullableString({ maxLength: 100 }),
      city: { bsonType: "string", minLength: 1, maxLength: 100 },
      state: { bsonType: "string", pattern: "^[A-Z]{2}$" },
      zip_code: { bsonType: "string", pattern: "^\\d{5}(-\\d{4})?$" },
      insurance_provider: nullableString({ maxLength: 100 }),
      insurance_member_id: nullableString({ maxLength: 50 }),
      preferred_language: { bsonType: "string", minLength: 1, maxLength: 50 },
      emergency_contact_name: nullableString({ maxLength: 100 }),
      emergency_contact_phone: nullableString({ pattern: "^(\\d{10})?$" }),
      created_at: { bsonType: "string" },
      updated_at: { bsonType: "string" },
      deleted_at: { bsonType: ["string", "null"] },
    },
  },
};

const APPOINTMENT_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: ["slot_id", "confirmation", "slot_date", "slot_time", "provider", "created_at"],
    properties: {
      slot_id: { bsonType: "string" },
      confirmation: { bsonType: "string" },
      slot_date: { bsonType: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      slot_time: { bsonType: "string" },
      provider: { bsonType: "string" },
      patient_id: { bsonType: ["string", "null"] },
      patient_name: { bsonType: ["string", "null"] },
      created_at: { bsonType: "string" },
    },
  },
};

// Unique indexes are load-bearing, not just performance:
//   patients.patient_id  — the API contract's identifier
//   calls.call_id        — makes the transcript upsert idempotent
//   appointments.slot_id — the database, not application code, is what stops two
//                          callers being given the same appointment slot
const COLLECTIONS = [
  {
    name: "patients",
    validator: PATIENT_VALIDATOR,
    indexes: [
      { key: { patient_id: 1 }, options: { unique: true, name: "uniq_patient_id" } },
      { key: { phone_number: 1 }, options: { name: "idx_phone" } },
      { key: { last_name: 1 }, options: { name: "idx_last_name" } },
      { key: { date_of_birth: 1 }, options: { name: "idx_dob" } },
      { key: { created_at: -1 }, options: { name: "idx_created_at" } },
    ],
  },
  {
    name: "calls",
    validator: null, // transcripts are free-form; nothing here is safety-critical
    indexes: [
      { key: { call_id: 1 }, options: { unique: true, name: "uniq_call_id" } },
      { key: { patient_id: 1 }, options: { name: "idx_call_patient" } },
      { key: { created_at: -1 }, options: { name: "idx_call_created_at" } },
    ],
  },
  {
    name: "appointments",
    validator: APPOINTMENT_VALIDATOR,
    indexes: [
      { key: { slot_id: 1 }, options: { unique: true, name: "uniq_slot_id" } },
      { key: { confirmation: 1 }, options: { unique: true, name: "uniq_confirmation" } },
      { key: { patient_id: 1 }, options: { name: "idx_appt_patient" } },
    ],
  },
];

/**
 * Create collections, validators and indexes. Idempotent, and memoized so it
 * costs one round trip per process (i.e. once per serverless cold start) rather
 * than one per request.
 *
 * Applying a validator needs the `dbAdmin` role, which an Atlas user scoped to
 * `readWrite` won't have. That's treated as a warning rather than a failure: the
 * indexes and the application-level validation still hold, and refusing to start
 * over a missing bonus guarantee would be the wrong trade.
 */
let migration = null;

export function migrate() {
  migration ??= runMigration().catch((err) => {
    migration = null; // let a later request retry rather than poisoning the process
    throw err;
  });
  return migration;
}

async function runMigration() {
  const database = await db();
  const existing = new Set(
    await database.listCollections({}, { nameOnly: true }).map((c) => c.name).toArray()
  );

  for (const { name, validator, indexes } of COLLECTIONS) {
    if (!existing.has(name)) {
      try {
        await database.createCollection(name, validator ? { validator } : {});
      } catch (err) {
        // NamespaceExists (48): another instance created it concurrently — fine.
        if (err.code !== 48) throw err;
      }
    } else if (validator) {
      try {
        await database.command({ collMod: name, validator });
      } catch (err) {
        console.log(
          `[db] could not apply the ${name} schema validator (${err.codeName ?? err.message}). ` +
            `Indexes and application-level validation are still active.`
        );
      }
    }

    await database.collection(name).createIndexes(
      indexes.map(({ key, options }) => ({ key, ...options }))
    );
  }
}

// --- Small helpers ---------------------------------------------------------

/**
 * Normalize an absent value to null. Kept for the same reason it existed under
 * SQL: optional fields arrive as undefined, and an explicit null is what the
 * validators and the API contract expect. The driver would otherwise drop the key
 * entirely, so a cleared field would look like it was never set.
 */
export function toBinding(value) {
  return value === undefined || value === "" ? null : value;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Mongo's _id is an implementation detail; the API contract exposes patient_id. */
export const WITHOUT_ID = { projection: { _id: 0 } };

export async function closeDb() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    /* never connected, or already closed */
  } finally {
    clientPromise = null;
    migration = null;
  }
}

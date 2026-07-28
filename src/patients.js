// src/patients.js
// Service layer: the single place patient records are read and written.
//
// Both front doors go through here — the REST API (src/api.js) and the voice
// agent's tools (tools.js). The brief allows the agent to either call the REST
// API over HTTP or invoke the same service layer directly; this project does the
// latter, so a tool call during a live phone call doesn't depend on the server
// being able to reach its own public URL. Same validation, same constraints, one
// code path.
//
// Everything is async because the database is over the network (see src/db.js).
//
// Convention: expected failures are returned as `{ ok: false, ... }` so callers
// can map them to a status code or a spoken sentence. Unexpected failures (a real
// database error) throw and surface as a 500.

import { randomUUID } from "node:crypto";
import { get, migrate, nowIso, query, run, toBinding } from "./db.js";
import {
  validatePatient,
  validators,
  WRITABLE_FIELDS,
  FIELD_LABELS,
  formatDob,
  formatPhone,
} from "./validation.js";

// --- Row -> API shape ------------------------------------------------------

/**
 * Rows are already the API shape, but `display` is attached for the humans: the
 * dashboard and the agent's spoken readback both need MM/DD/YYYY and
 * (415) 555-0123 rather than the canonical storage formats.
 */
function serialize(row) {
  if (!row) return null;
  return {
    ...row,
    display: {
      full_name: `${row.first_name} ${row.last_name}`,
      date_of_birth: formatDob(row.date_of_birth),
      phone_number: formatPhone(row.phone_number),
      emergency_contact_phone: formatPhone(row.emergency_contact_phone),
    },
  };
}

// --- Reads -----------------------------------------------------------------

/**
 * List patients, optionally filtered. Soft-deleted records are excluded unless
 * explicitly asked for.
 *
 * Filter values run through the same validators as writes, so
 * `?date_of_birth=03/04/1990` and `?date_of_birth=1990-03-04` both match, and
 * `?phone_number=(415) 555-0123` matches the stored bare digits.
 *
 * @returns {Promise<{ ok: true, patients: object[] }
 *          | { ok: false, errors: Array<{field: string, message: string}> }>}
 */
export async function listPatients(filters = {}) {
  await migrate();

  const where = ["(deleted_at IS NULL OR ? = 1)"];
  const params = [filters.include_deleted ? 1 : 0];
  const errors = [];

  if (filters.last_name) {
    // Case-insensitive exact match — predictable for an API client. A prefix
    // search would be friendlier for the dashboard but ambiguous here.
    where.push("last_name = ? COLLATE NOCASE");
    params.push(String(filters.last_name).trim());
  }

  for (const field of ["date_of_birth", "phone_number"]) {
    if (!filters[field]) continue;
    const result = validators[field](filters[field]);
    if (!result.ok) {
      errors.push({ field, message: `Invalid ${FIELD_LABELS[field]} filter.` });
      continue;
    }
    where.push(`${field} = ?`);
    params.push(result.value);
  }

  if (errors.length) return { ok: false, errors };

  const rows = await query(
    `SELECT * FROM patients WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
    params
  );

  return { ok: true, patients: rows.map(serialize) };
}

export async function getPatient(patientId, { includeDeleted = false } = {}) {
  if (!patientId) return null;
  await migrate();
  const row = await get(
    `SELECT * FROM patients
     WHERE patient_id = ? AND (deleted_at IS NULL OR ? = 1)`,
    [String(patientId), includeDeleted ? 1 : 0]
  );
  return serialize(row);
}

/**
 * Duplicate detection. The voice agent calls this as soon as it has a phone
 * number so it can offer to update an existing record instead of creating a
 * second one for the same person.
 */
export async function findByPhone(phone) {
  const result = validators.phone_number(phone);
  if (!result.ok) return null;
  await migrate();
  const row = await get(
    `SELECT * FROM patients
     WHERE phone_number = ? AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [result.value]
  );
  return serialize(row);
}

// --- Writes ----------------------------------------------------------------

/**
 * Create a patient. Validates and normalizes first; nothing partial is written.
 *
 * @returns {Promise<{ ok: true, patient: object } | { ok: false, errors: [...] }>}
 */
export async function createPatient(input) {
  const validated = validatePatient(input, { partial: false });
  if (!validated.ok) return { ok: false, errors: validated.errors };

  await migrate();

  const record = {
    patient_id: randomUUID(),
    ...validated.value,
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  };

  const columns = Object.keys(record);
  await run(
    `INSERT INTO patients (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((c) => toBinding(record[c]))
  );

  return { ok: true, patient: await getPatient(record.patient_id) };
}

/**
 * Partial update. Only the fields present in `input` are touched.
 *
 * @returns {Promise<{ ok: true, patient: object }
 *          | { ok: false, notFound: true }
 *          | { ok: false, errors: [...] }>}
 */
export async function updatePatient(patientId, input) {
  const existing = await getPatient(patientId);
  if (!existing) return { ok: false, notFound: true };

  const validated = validatePatient(input, { partial: true });
  if (!validated.ok) return { ok: false, errors: validated.errors };

  const changes = Object.keys(validated.value).filter((f) => WRITABLE_FIELDS.includes(f));
  if (!changes.length) {
    return { ok: false, errors: [{ field: null, message: "No updatable fields were provided." }] };
  }

  await run(
    `UPDATE patients
     SET ${changes.map((f) => `${f} = ?`).join(", ")}, updated_at = ?
     WHERE patient_id = ? AND deleted_at IS NULL`,
    [...changes.map((f) => toBinding(validated.value[f])), nowIso(), String(patientId)]
  );

  return { ok: true, patient: await getPatient(patientId), changed: changes };
}

/**
 * Soft delete — sets `deleted_at` and leaves the row in place, per the brief.
 * Deleting an already-deleted record reports notFound, since it's no longer
 * visible.
 */
export async function softDeletePatient(patientId) {
  const existing = await getPatient(patientId);
  if (!existing) return { ok: false, notFound: true };

  const timestamp = nowIso();
  await run(
    `UPDATE patients SET deleted_at = ?, updated_at = ?
     WHERE patient_id = ? AND deleted_at IS NULL`,
    [timestamp, timestamp, String(patientId)]
  );

  return { ok: true, patient: await getPatient(patientId, { includeDeleted: true }) };
}

// --- Call records ----------------------------------------------------------

/**
 * Remember which patient an in-flight call is about, so `end-of-call-report` can
 * link the transcript to the record.
 *
 * This lives in the database rather than a Map because on Vercel each tool call
 * may be served by a different serverless instance — in-process state would be
 * silently lost between one tool call and the next.
 */
export async function linkCallToPatient(callId, patientId) {
  if (!callId || !patientId) return;
  await migrate();
  await run(
    `INSERT INTO calls (call_id, patient_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT (call_id) DO UPDATE SET patient_id = excluded.patient_id`,
    [String(callId), String(patientId), nowIso()]
  );
}

export async function getCallPatientId(callId) {
  if (!callId) return null;
  await migrate();
  const row = await get("SELECT patient_id FROM calls WHERE call_id = ?", [String(callId)]);
  return row?.patient_id ?? null;
}

/**
 * Store a call's summary/transcript. Called from the `end-of-call-report`
 * webhook. Preserves any patient_id already linked during the call. Best-effort:
 * a failure to log a transcript must never look like a failed registration.
 */
export async function recordCall({ callId, patientId, endedReason, summary, transcript }) {
  await migrate();
  await run(
    `INSERT INTO calls (call_id, patient_id, ended_reason, summary, transcript, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (call_id) DO UPDATE SET
       patient_id   = COALESCE(excluded.patient_id, calls.patient_id),
       ended_reason = excluded.ended_reason,
       summary      = excluded.summary,
       transcript   = excluded.transcript`,
    [
      toBinding(callId) ?? randomUUID(),
      toBinding(patientId),
      toBinding(endedReason),
      toBinding(summary),
      toBinding(transcript),
      nowIso(),
    ]
  );
}

export async function listCalls(limit = 50) {
  await migrate();
  return query(
    `SELECT c.*, p.first_name, p.last_name
     FROM calls c LEFT JOIN patients p ON p.patient_id = c.patient_id
     ORDER BY c.created_at DESC LIMIT ?`,
    [Math.min(Number(limit) || 50, 200)]
  );
}

export async function countPatients() {
  await migrate();
  const row = await get("SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NULL");
  return Number(row?.n ?? 0);
}

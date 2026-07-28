// src/patients.js
// Service layer: the single place patient records are read and written.
//
// Both front doors go through here — the REST API (src/api.js) and the voice
// agent's tools (tools.js). The brief allows the agent to either call the REST API
// over HTTP or invoke the same service layer directly; this project does the
// latter, so a tool call during a live phone call doesn't depend on the server
// being able to reach its own public URL. Same validation, same constraints, one
// code path.
//
// Convention: expected failures are returned as `{ ok: false, ... }` so callers
// can map them to a status code or a spoken sentence. Unexpected failures (a real
// database error) throw and surface as a 500.

import { randomUUID } from "node:crypto";
import { collection, nowIso, toBinding, WITHOUT_ID } from "./db.js";
import {
  validatePatient,
  validators,
  WRITABLE_FIELDS,
  OPTIONAL_FIELDS,
  FIELD_LABELS,
  formatDob,
  formatPhone,
} from "./validation.js";

// Case-insensitive comparison, used for the ?last_name= filter. Collation is the
// right tool here — a regex would need escaping and wouldn't use the index.
const CASE_INSENSITIVE = { locale: "en", strength: 2 };

// --- Document -> API shape -------------------------------------------------

/**
 * Documents are already the API shape (`_id` is projected away at query time),
 * but `display` is attached for the humans: the dashboard and the agent's spoken
 * readback both need MM/DD/YYYY and (415) 555-0123 rather than the canonical
 * storage formats.
 */
function serialize(doc) {
  if (!doc) return null;
  return {
    ...doc,
    display: {
      full_name: `${doc.first_name} ${doc.last_name}`,
      date_of_birth: formatDob(doc.date_of_birth),
      phone_number: formatPhone(doc.phone_number),
      emergency_contact_phone: formatPhone(doc.emergency_contact_phone),
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
  const query = {};
  const errors = [];

  if (!filters.include_deleted) query.deleted_at = null;

  if (filters.last_name) query.last_name = String(filters.last_name).trim();

  for (const field of ["date_of_birth", "phone_number"]) {
    if (!filters[field]) continue;
    const result = validators[field](filters[field]);
    if (!result.ok) {
      errors.push({ field, message: `Invalid ${FIELD_LABELS[field]} filter.` });
      continue;
    }
    query[field] = result.value;
  }

  if (errors.length) return { ok: false, errors };

  const patients = await collection("patients");
  const docs = await patients
    .find(query, WITHOUT_ID)
    .collation(CASE_INSENSITIVE) // makes ?last_name= case-insensitive
    .sort({ created_at: -1 })
    .toArray();

  return { ok: true, patients: docs.map(serialize) };
}

export async function getPatient(patientId, { includeDeleted = false } = {}) {
  if (!patientId) return null;
  const patients = await collection("patients");
  const query = { patient_id: String(patientId) };
  if (!includeDeleted) query.deleted_at = null;
  return serialize(await patients.findOne(query, WITHOUT_ID));
}

/**
 * Duplicate detection. The voice agent calls this as soon as it has a phone number
 * so it can offer to update an existing record instead of creating a second one
 * for the same person.
 */
export async function findByPhone(phone) {
  const result = validators.phone_number(phone);
  if (!result.ok) return null;

  const patients = await collection("patients");
  const doc = await patients.findOne(
    { phone_number: result.value, deleted_at: null },
    { ...WITHOUT_ID, sort: { created_at: -1 } }
  );
  return serialize(doc);
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

  const timestamp = nowIso();
  const record = {
    patient_id: randomUUID(),
    ...validated.value,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
  };

  // Every optional field is stored explicitly as null rather than omitted, so the
  // API response shape is identical for every record and a cleared field is
  // distinguishable from one that was never set.
  for (const field of OPTIONAL_FIELDS) {
    record[field] = toBinding(record[field]);
  }

  const patients = await collection("patients");
  await patients.insertOne(record);

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

  const update = { updated_at: nowIso() };
  for (const field of changes) update[field] = toBinding(validated.value[field]);

  const patients = await collection("patients");
  await patients.updateOne(
    { patient_id: String(patientId), deleted_at: null },
    { $set: update }
  );

  return { ok: true, patient: await getPatient(patientId), changed: changes };
}

/**
 * Soft delete — sets `deleted_at` and leaves the document in place, per the brief.
 * Deleting an already-deleted record reports notFound, since it's no longer
 * visible.
 */
export async function softDeletePatient(patientId) {
  const existing = await getPatient(patientId);
  if (!existing) return { ok: false, notFound: true };

  const timestamp = nowIso();
  const patients = await collection("patients");
  await patients.updateOne(
    { patient_id: String(patientId), deleted_at: null },
    { $set: { deleted_at: timestamp, updated_at: timestamp } }
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
  const calls = await collection("calls");
  await calls.updateOne(
    { call_id: String(callId) },
    {
      $set: { patient_id: String(patientId) },
      $setOnInsert: { call_id: String(callId), created_at: nowIso() },
    },
    { upsert: true }
  );
}

// --- Per-call validation attempt tracking ----------------------------------
// Why this lives here and not in the prompt: an LLM cannot reliably count "have
// I now asked for this three times?" across conversational turns. Telling it to
// try was the wrong instinct — the same one the prompt already forbids for date
// validity. The server sees every attempt, so the server counts them.
//
// Stored on the call document so it survives between serverless invocations, and
// disappears with the call rather than accumulating forever.

/**
 * Record a failed attempt for each named field and return the updated counts.
 * @returns {Promise<Record<string, number>>}
 */
export async function recordFieldFailures(callId, fields) {
  if (!callId || !fields?.length) return {};

  const increments = {};
  for (const field of fields) increments[`attempts.${field}`] = 1;

  const calls = await collection("calls");
  const doc = await calls.findOneAndUpdate(
    { call_id: String(callId) },
    { $inc: increments, $setOnInsert: { call_id: String(callId), created_at: nowIso() } },
    { upsert: true, returnDocument: "after", projection: { attempts: 1 } }
  );

  return doc?.attempts ?? {};
}

/** Forget the failures for fields that have now come back valid. */
export async function clearFieldFailures(callId, fields) {
  if (!callId || !fields?.length) return;

  const unset = {};
  for (const field of fields) unset[`attempts.${field}`] = "";

  const calls = await collection("calls");
  await calls.updateOne({ call_id: String(callId) }, { $unset: unset });
}

export async function getCallPatientId(callId) {
  if (!callId) return null;
  const calls = await collection("calls");
  const doc = await calls.findOne({ call_id: String(callId) }, { projection: { patient_id: 1 } });
  return doc?.patient_id ?? null;
}

/**
 * Store a call's summary/transcript. Called from the `end-of-call-report` webhook.
 * Preserves any patient_id already linked during the call — hence the conditional
 * $set rather than overwriting it with a possibly-null value. Best-effort: a
 * failure to log a transcript must never look like a failed registration.
 */
export async function recordCall({ callId, patientId, endedReason, summary, transcript }) {
  const id = String(callId ?? randomUUID());
  const calls = await collection("calls");

  const set = {
    ended_reason: toBinding(endedReason),
    summary: toBinding(summary),
    transcript: toBinding(transcript),
  };
  if (patientId) set.patient_id = String(patientId);

  await calls.updateOne(
    { call_id: id },
    { $set: set, $setOnInsert: { call_id: id, created_at: nowIso() } },
    { upsert: true }
  );
}

/**
 * Recent calls with the patient's name joined in, for GET /calls. Uses $lookup so
 * it stays one round trip rather than N+1 queries.
 */
export async function listCalls(limit = 50) {
  const calls = await collection("calls");
  return calls
    .aggregate([
      { $sort: { created_at: -1 } },
      { $limit: Math.min(Number(limit) || 50, 200) },
      {
        $lookup: {
          from: "patients",
          localField: "patient_id",
          foreignField: "patient_id",
          as: "patient",
        },
      },
      {
        $addFields: {
          first_name: { $first: "$patient.first_name" },
          last_name: { $first: "$patient.last_name" },
        },
      },
      { $project: { _id: 0, patient: 0 } },
    ])
    .toArray();
}

export async function countPatients() {
  const patients = await collection("patients");
  return patients.countDocuments({ deleted_at: null });
}

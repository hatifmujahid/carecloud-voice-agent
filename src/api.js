// src/api.js
// REST API for patient records. Thin layer: parse the request, call the service
// layer, map the result to a status code. All validation is server-side in
// src/validation.js — the voice agent is never trusted as the only guard.
//
// Every response uses the same envelope:
//   success -> { "data": <payload>, "error": null }
//   failure -> { "data": null, "error": { "code", "message", "details"? } }

import { Router } from "express";
import {
  createPatient,
  getPatient,
  listPatients,
  softDeletePatient,
  updatePatient,
  listCalls,
  countPatients,
} from "./patients.js";
import { cancelSlot, listBooked } from "./appointments.js";
import { log } from "./logger.js";

export const api = Router();

// --- Envelope helpers ------------------------------------------------------

const sendData = (res, status, data) => res.status(status).json({ data, error: null });

const sendError = (res, status, code, message, details) =>
  res.status(status).json({
    data: null,
    error: { code, message, ...(details ? { details } : {}) },
  });

// A UUID in the path that isn't a UUID is a malformed request (400), which is
// more useful to a client than a blanket 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(req, res) {
  if (UUID_RE.test(req.params.id)) return true;
  sendError(res, 400, "invalid_id", "patient_id must be a UUID.");
  return false;
}

// Express 4 doesn't forward async rejections to the error handler, so wrap.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// --- Routes ----------------------------------------------------------------

/**
 * GET /patients
 * Optional filters: ?last_name= ?date_of_birth= ?phone_number=
 * ?include_deleted=true to also return soft-deleted records.
 */
api.get(
  "/patients",
  wrap(async (req, res) => {
    const result = await listPatients({
      last_name: req.query.last_name,
      date_of_birth: req.query.date_of_birth,
      phone_number: req.query.phone_number,
      include_deleted: req.query.include_deleted === "true",
    });

    if (!result.ok) {
      return sendError(res, 422, "invalid_filter", "One or more filters were invalid.", result.errors);
    }
    return sendData(res, 200, { count: result.patients.length, patients: result.patients });
  })
);

/** GET /patients/:id */
api.get(
  "/patients/:id",
  wrap(async (req, res) => {
    if (!requireUuid(req, res)) return;
    const patient = await getPatient(req.params.id);
    if (!patient) return sendError(res, 404, "not_found", "No patient with that patient_id.");
    return sendData(res, 200, patient);
  })
);

/** POST /patients — create. 201 with the created record. */
api.post(
  "/patients",
  wrap(async (req, res) => {
    const result = await createPatient(req.body);
    if (!result.ok) {
      return sendError(res, 422, "validation_failed", "The patient record is not valid.", result.errors);
    }
    log("patient.created", {
      source: "api",
      summary: `${result.patient.display.full_name} (${result.patient.patient_id})`,
      patient: result.patient,
    });
    return sendData(res, 201, result.patient);
  })
);

/** PUT /patients/:id — partial update allowed. */
api.put(
  "/patients/:id",
  wrap(async (req, res) => {
    if (!requireUuid(req, res)) return;
    const result = await updatePatient(req.params.id, req.body);

    if (result.notFound) return sendError(res, 404, "not_found", "No patient with that patient_id.");
    if (!result.ok) {
      return sendError(res, 422, "validation_failed", "The update is not valid.", result.errors);
    }
    log("patient.updated", {
      source: "api",
      summary: `${result.patient.display.full_name} — ${result.changed.join(", ")}`,
      patient_id: result.patient.patient_id,
      changed: result.changed,
    });
    return sendData(res, 200, result.patient);
  })
);

/** DELETE /patients/:id — soft delete, sets deleted_at. */
api.delete(
  "/patients/:id",
  wrap(async (req, res) => {
    if (!requireUuid(req, res)) return;
    const result = await softDeletePatient(req.params.id);

    if (result.notFound) return sendError(res, 404, "not_found", "No patient with that patient_id.");
    log("patient.deleted", { source: "api", summary: result.patient.patient_id });
    return sendData(res, 200, result.patient);
  })
);

/** GET /calls — call transcripts/summaries (bonus, powers the dashboard). */
api.get(
  "/calls",
  wrap(async (req, res) => sendData(res, 200, { calls: await listCalls(req.query.limit) }))
);

/**
 * GET /appointments — booked appointments (scheduling bonus).
 * DELETE /appointments/:slot_id — cancel one, releasing the slot back on offer.
 */
api.get(
  "/appointments",
  wrap(async (_req, res) => sendData(res, 200, { appointments: await listBooked() }))
);

api.delete(
  "/appointments/:slot_id",
  wrap(async (req, res) => {
    const result = await cancelSlot(req.params.slot_id);
    if (result.notFound) return sendError(res, 404, "not_found", "No appointment booked for that slot_id.");
    log("appointment.cancelled", { summary: req.params.slot_id });
    return sendData(res, 200, result.appointment);
  })
);

/** GET /stats — small counters for the dashboard header. */
api.get(
  "/stats",
  wrap(async (_req, res) => sendData(res, 200, { patients: await countPatients() }))
);

// --- Errors ----------------------------------------------------------------

/** 404 for unknown /api/* paths, so clients get the envelope rather than HTML. */
api.use((req, res) => sendError(res, 404, "no_route", `No API route for ${req.method} ${req.originalUrl}.`));

/**
 * Terminal error handler. Malformed JSON is a client error (400); anything else
 * that reached here is a bug, so log it and return 500 without leaking internals.
 * Must keep the 4-argument signature for Express to treat it as error middleware.
 */
// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return sendError(res, 400, "invalid_json", "Request body is not valid JSON.");
  }
  if (err?.type === "entity.too.large") {
    return sendError(res, 400, "payload_too_large", "Request body is too large.");
  }
  log("api.error", { message: err?.message, stack: err?.stack });
  return sendError(res, 500, "internal_error", "Something went wrong handling that request.");
});

// src/appointments.js
// Mock scheduling for the optional "offer a first appointment" bonus.
//
// Two decisions worth explaining:
//
// 1. Offered slots are *generated from today's date*, not stored. A seeded table
//    of slots would go stale — after a few days the agent would be offering
//    appointments in the past. Generating them means the demo works whenever it's
//    reviewed.
// 2. Bookings *are* stored, keyed by `slot_id` as the primary key. The database
//    therefore prevents two callers being given the same slot, with no
//    in-process bookkeeping — which matters because on Vercel the two calls may
//    be handled by different serverless instances.
//
// The clinic, providers and times are mock data; the brief permits that.

import { randomUUID } from "node:crypto";
import { get, migrate, nowIso, query, run, toBinding } from "./db.js";

const TIMES = [
  { time: "9:00 AM", provider: "Dr. Patel" },
  { time: "2:30 PM", provider: "Dr. Okafor" },
];

const DAYS_AHEAD = [2, 3, 4]; // soonest first; skips today and tomorrow

function isoDate(daysFromNow) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function spokenDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Stable id encoding the date and time, e.g. S-20260730-0900. */
const slotId = (isoDay, time) =>
  `S-${isoDay.replace(/-/g, "")}-${time.replace(/[: ]/g, "").padStart(6, "0")}`;

/** Every slot the clinic could offer right now, booked or not. */
function candidateSlots() {
  const slots = [];
  for (const days of DAYS_AHEAD) {
    const date = isoDate(days);
    for (const { time, provider } of TIMES) {
      slots.push({ slot_id: slotId(date, time), date, time, provider, spoken_date: spokenDate(date) });
    }
  }
  return slots;
}

/** Open slots only — anything already booked is filtered out. */
export async function listSlots() {
  await migrate();
  const candidates = candidateSlots();
  const rows = await query(
    `SELECT slot_id FROM appointments WHERE slot_id IN (${candidates.map(() => "?").join(", ")})`,
    candidates.map((s) => s.slot_id)
  );
  const taken = new Set(rows.map((r) => r.slot_id));
  return candidates.filter((s) => !taken.has(s.slot_id));
}

/**
 * Book a slot. Rejects anything that isn't currently on offer, and relies on the
 * primary key to reject a slot that was taken between the caller hearing it and
 * accepting it.
 */
export async function bookSlot({ slotId: id, patientId, patientName }) {
  await migrate();

  const slot = candidateSlots().find((s) => s.slot_id === id);
  if (!slot) {
    return {
      ok: false,
      message: "That slot id isn't one of the open times. Call listAppointmentSlots again and offer a real one.",
    };
  }

  const confirmation = `CC-${randomUUID().slice(0, 6).toUpperCase()}`;

  try {
    await run(
      `INSERT INTO appointments
         (slot_id, confirmation, slot_date, slot_time, provider, patient_id, patient_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slot.slot_id,
        confirmation,
        slot.date,
        slot.time,
        slot.provider,
        toBinding(patientId),
        toBinding(patientName),
        nowIso(),
      ]
    );
  } catch (err) {
    // A primary-key collision means someone else took it first. Anything else is
    // a real error and should surface.
    if (/UNIQUE|constraint/i.test(err.message)) {
      return {
        ok: false,
        message: "That time was just taken. Offer the caller one of the remaining slots.",
      };
    }
    throw err;
  }

  return {
    ok: true,
    appointment: { ...slot, confirmation, patient_id: patientId ?? null, patient_name: patientName ?? null },
  };
}

/** All booked appointments, newest first. Powers GET /appointments. */
export async function listBooked() {
  await migrate();
  return query(
    `SELECT a.*, p.first_name, p.last_name
     FROM appointments a LEFT JOIN patients p ON p.patient_id = a.patient_id
     ORDER BY a.slot_date, a.slot_time`
  );
}

/**
 * Cancel a booking and release the slot back to the offered set.
 *
 * Bookings are persistent, so without this the six generated slots would be
 * consumed permanently — including by the test suite, which books one per run.
 */
export async function cancelSlot(slotId) {
  await migrate();
  const existing = await get("SELECT * FROM appointments WHERE slot_id = ?", [String(slotId)]);
  if (!existing) return { ok: false, notFound: true };

  await run("DELETE FROM appointments WHERE slot_id = ?", [String(slotId)]);
  return { ok: true, appointment: existing };
}

export async function getAppointmentForPatient(patientId) {
  if (!patientId) return null;
  await migrate();
  return get(
    `SELECT * FROM appointments WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1`,
    [String(patientId)]
  );
}

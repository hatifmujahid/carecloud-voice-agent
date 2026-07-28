// src/appointments.js
// Mock scheduling for the optional "offer a first appointment" bonus.
//
// Two decisions worth explaining:
//
// 1. Offered slots are *generated from today's date*, not stored. A seeded
//    collection of slots would go stale — after a few days the agent would be
//    offering appointments in the past. Generating them means the demo works
//    whenever it's reviewed.
// 2. Bookings *are* stored, with a unique index on `slot_id`. The database
//    therefore prevents two callers being given the same slot, with no in-process
//    bookkeeping — which matters because on Vercel the two calls may be handled by
//    different serverless instances.
//
// The clinic, providers and times are mock data; the brief permits that.

import { randomUUID } from "node:crypto";
import { collection, nowIso, toBinding, WITHOUT_ID } from "./db.js";

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

/** Stable id encoding the date and time, e.g. S-20260730-0900AM. */
const slotId = (isoDay, time) =>
  `S-${isoDay.replace(/-/g, "")}-${time.replace(/[: ]/g, "")}`;

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
  const candidates = candidateSlots();
  const appointments = await collection("appointments");
  const booked = await appointments
    .find({ slot_id: { $in: candidates.map((s) => s.slot_id) } }, { projection: { slot_id: 1 } })
    .toArray();

  const taken = new Set(booked.map((b) => b.slot_id));
  return candidates.filter((s) => !taken.has(s.slot_id));
}

/**
 * Book a slot. Rejects anything that isn't currently on offer, and relies on the
 * unique index to reject a slot taken between the caller hearing it and accepting
 * it — the race is settled by the database, not by application code.
 */
export async function bookSlot({ slotId: id, patientId, patientName }) {
  const slot = candidateSlots().find((s) => s.slot_id === id);
  if (!slot) {
    return {
      ok: false,
      message:
        "That slot id isn't one of the open times. Call listAppointmentSlots again and offer a real one.",
    };
  }

  const confirmation = `CC-${randomUUID().slice(0, 6).toUpperCase()}`;
  const appointments = await collection("appointments");

  try {
    await appointments.insertOne({
      slot_id: slot.slot_id,
      confirmation,
      slot_date: slot.date,
      slot_time: slot.time,
      provider: slot.provider,
      patient_id: toBinding(patientId),
      patient_name: toBinding(patientName),
      created_at: nowIso(),
    });
  } catch (err) {
    // 11000 is duplicate key: someone else took the slot first.
    if (err.code === 11000) {
      return {
        ok: false,
        message: "That time was just taken. Offer the caller one of the remaining slots.",
      };
    }
    throw err;
  }

  return {
    ok: true,
    appointment: {
      ...slot,
      confirmation,
      patient_id: patientId ?? null,
      patient_name: patientName ?? null,
    },
  };
}

/** All booked appointments, soonest first. Powers GET /appointments. */
export async function listBooked() {
  const appointments = await collection("appointments");
  return appointments
    .find({}, WITHOUT_ID)
    .sort({ slot_date: 1, slot_time: 1 })
    .toArray();
}

/**
 * Cancel a booking and release the slot back to the offered set.
 *
 * Bookings are persistent, so without this the six generated slots would be
 * consumed permanently — including by the test suite, which books one per run.
 */
export async function cancelSlot(id) {
  const appointments = await collection("appointments");
  const existing = await appointments.findOne({ slot_id: String(id) }, WITHOUT_ID);
  if (!existing) return { ok: false, notFound: true };

  await appointments.deleteOne({ slot_id: String(id) });
  return { ok: true, appointment: existing };
}

export async function getAppointmentForPatient(patientId) {
  if (!patientId) return null;
  const appointments = await collection("appointments");
  return appointments.findOne(
    { patient_id: String(patientId) },
    { ...WITHOUT_ID, sort: { created_at: -1 } }
  );
}

// tools.js
// The functions the voice agent can call mid-conversation.
//
// Design notes — these shape what the caller hears, so they matter as much as
// the prompt:
//
//  * Results are small and unambiguous. Everything returned here is fed back to
//    the LLM as text; a large or vague payload makes the agent ramble or guess.
//  * Failures are never bare booleans. Each one carries a `message` written to
//    be spoken aloud and, where useful, a `next_step` telling the model what to
//    do. That is what turns a validation failure into "I think I misheard the
//    year — what year were you born?" instead of dead air.
//  * `validateFields` takes a *batch*. Validating one field per tool call would
//    add a round trip to every question and make the call feel sluggish; the
//    agent instead checks a group (name+DOB+sex, then the address) in one hop.
//  * Persistence goes through src/patients.js — the same service layer the REST
//    API uses, so a record written by phone and one written by POST /patients
//    are validated identically.
//
// Adding a tool means editing two files that must agree: the implementation
// here and the JSON schema in scripts/deployAssistant.js.

import {
  clearFieldFailures,
  createPatient,
  findByPhone,
  recordFieldFailures,
  updatePatient,
} from "./src/patients.js";
import {
  FIELD_LABELS,
  REQUIRED_FIELDS,
  WRITABLE_FIELDS,
  validatePatient,
} from "./src/validation.js";
import { bookSlot, listSlots } from "./src/appointments.js";
import { sayAndEndCall } from "./src/vapiControl.js";
import { log } from "./src/logger.js";

// --- Spoken formatting -----------------------------------------------------
// Canonical storage formats don't read well through TTS: "1990-03-04" gets
// spoken as a subtraction and "4155550123" as one enormous number. These give
// the model text that sounds right when read back to the caller.

function spokenDob(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return `${new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })}`;
}

// Grouped digits, so TTS reads "four one five, five five five, oh one two three".
const spokenPhone = (d) =>
  d && d.length === 10 ? `${d.slice(0, 3)}, ${d.slice(3, 6)}, ${d.slice(6)}` : d;

const spokenZip = (z) => (z ? String(z).split("").join(" ").replace(/ - /, ", dash, ") : z);

/** Add spoken variants for the fields that need them. */
function withSpoken(values) {
  const spoken = {};
  if (values.date_of_birth) spoken.date_of_birth = spokenDob(values.date_of_birth);
  if (values.phone_number) spoken.phone_number = spokenPhone(values.phone_number);
  if (values.emergency_contact_phone) {
    spoken.emergency_contact_phone = spokenPhone(values.emergency_contact_phone);
  }
  if (values.zip_code) spoken.zip_code = spokenZip(values.zip_code);
  return Object.keys(spoken).length ? spoken : undefined;
}

/** Pull only the writable patient fields out of a tool's arguments. */
function pickFields(args = {}) {
  const picked = {};
  for (const field of WRITABLE_FIELDS) {
    if (args[field] !== undefined && args[field] !== null && String(args[field]).trim() !== "") {
      picked[field] = args[field];
    }
  }
  return picked;
}

/**
 * Keep the agent focused. Handing back eight simultaneous errors makes it
 * either dump them all at the caller or pick one at random; two at a time keeps
 * the recovery conversational.
 */
const firstErrors = (errors, limit = 2) =>
  errors.slice(0, limit).map((e) => ({
    field: e.field,
    label: e.field ? FIELD_LABELS[e.field] : undefined,
    say: e.message,
  }));

// --- Giving up on a field --------------------------------------------------
// A bad line means some fields simply cannot be captured, and an agent with no
// stopping rule will ask forever. The count is kept server-side (see
// src/patients.js) because a model can't reliably track "how many times have I
// asked this?" across turns — the earlier version of this lived in the prompt and
// did not work.

const MAX_ATTEMPTS = 3;

/**
 * Record this round's failures and report any field that has now been asked too
 * many times.
 *
 * Only fields the caller actually *provided* are counted. "I still need your date
 * of birth" means it hasn't been asked for yet — counting that as a failed attempt
 * would let one early registerPatient call with a partial payload burn the budget
 * for every field at once.
 *
 * @param {object} provided the fields present in this tool call
 * @returns {Promise<string[]>} fields to stop asking for
 */
async function registerFailures(callId, errors, provided) {
  const fields = errors
    .map((e) => e.field)
    .filter(Boolean)
    .filter((field) => Object.prototype.hasOwnProperty.call(provided ?? {}, field));

  if (!callId || !fields.length) return [];

  const counts = await recordFieldFailures(callId, fields);
  return fields.filter((field) => (counts[field] ?? 0) >= MAX_ATTEMPTS);
}

/**
 * Stop asking, say goodbye, and end the call.
 *
 * The hang-up is done by the server through Vapi's call control URL, not by asking
 * the model to call endCall. This path exists because the conversation has already
 * broken down; leaning on the model to end it correctly at that exact moment would
 * be leaning on the part that is failing. If the control URL isn't available the
 * result still instructs the model to end the call, so the behaviour degrades
 * rather than disappearing.
 */
async function giveUp(fields, context = {}) {
  const labels = fields.map((f) => FIELD_LABELS[f] ?? f);
  const list =
    labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];

  const farewell =
    `I'm sorry — I'm having real trouble getting your ${list} clearly, and I don't want to guess ` +
    `at it. I'll have someone from our office call you back to finish your registration. ` +
    `Thanks for your patience, and sorry about that.`;

  const ended = await sayAndEndCall(context.controlUrl, farewell);

  return {
    ok: false,
    saved: false,
    give_up: true,
    fields,
    call_ending: ended,
    say: farewell,
    next_step: ended
      ? "The call is already being ended by the server, which will speak the `say` line. Do not " +
        "say anything further and do not ask for that field again."
      : "Stop asking for that field — the line will not carry it. Say the `say` line, then end the " +
        "call with the endCall tool. Do not try again.",
  };
}

// --- Tools -----------------------------------------------------------------

export const tools = {
  /**
   * Duplicate detection. The agent calls this as soon as it has a phone number.
   * A match means offering to update rather than silently creating a second
   * record for the same person.
   */
  lookupPatientByPhone: async ({ phone_number } = {}) => {
    const patient = await findByPhone(phone_number);
    if (!patient) {
      return {
        found: false,
        next_step: "No existing record. Continue collecting the remaining details as a new registration.",
      };
    }

    log("tool.lookup.match", {
      summary: `${patient.display.full_name} (${patient.patient_id})`,
      patient_id: patient.patient_id,
    });

    return {
      found: true,
      patient_id: patient.patient_id,
      first_name: patient.first_name,
      last_name: patient.last_name,
      date_of_birth: patient.date_of_birth,
      spoken: { date_of_birth: spokenDob(patient.date_of_birth) },
      next_step:
        `Say: "It looks like we already have a record for ${patient.first_name} ${patient.last_name}. ` +
        `Would you like to update your information instead?" If yes, collect only what they want to change ` +
        `and call updatePatientRecord with this patient_id. If they say it is not them, register them as new.`,
    };
  },

  /**
   * Validate and normalize a batch of fields mid-conversation, before the final
   * save. Returns canonical values plus spoken variants — the agent reads those
   * back so the caller confirms what will actually be stored, not what the
   * agent thinks it heard.
   */
  validateFields: async (args = {}, context = {}) => {
    const fields = pickFields(args);
    if (!Object.keys(fields).length) {
      return { ok: false, message: "No fields were provided to validate." };
    }

    // partial: true — this is a mid-call check, not the final completeness gate.
    const result = validatePatient(fields, { partial: true });

    if (!result.ok) {
      const exhausted = await registerFailures(context.callId, result.errors, fields);
      if (exhausted.length) {
        log("tool.give_up", { summary: exhausted.join(", "), call_id: context.callId });
        return giveUp(exhausted, context);
      }
      return {
        ok: false,
        errors: firstErrors(result.errors),
        next_step:
          "Re-ask only for the listed field(s), using the wording in `say`. Keep everything else you already have.",
      };
    }

    // These fields are settled — forget any earlier trouble with them, so a
    // caller who eventually gets one right isn't penalized later in the call.
    await clearFieldFailures(context.callId, Object.keys(result.value));

    return {
      ok: true,
      normalized: result.value,
      spoken: withSpoken(result.value),
      next_step:
        "These values are valid and are exactly what will be saved. Use the `spoken` versions when reading them back.",
    };
  },

  /**
   * Final save. Validates the whole record, then writes it. Nothing partial is
   * ever written: either the caller is registered or they hear why not.
   */
  registerPatient: async (args = {}, context = {}) => {
    const fields = pickFields(args);

    // Duplicate guard. `lookupPatientByPhone` should have caught this earlier,
    // but the agent can skip a step, and creating two records for one person is
    // worse than one extra question.
    if (fields.phone_number && args.allow_duplicate !== true) {
      const existing = await findByPhone(fields.phone_number);
      if (existing) {
        return {
          ok: false,
          duplicate: true,
          patient_id: existing.patient_id,
          say: `It looks like we already have a record for ${existing.first_name} ${existing.last_name}. Would you like me to update it instead of creating a new one?`,
          next_step:
            "If they want it updated, call updatePatientRecord with this patient_id. If they insist this is a different person at the same number, call registerPatient again with allow_duplicate set to true.",
        };
      }
    }

    const result = await createPatient(fields);

    if (!result.ok) {
      const missing = result.errors.filter((e) => REQUIRED_FIELDS.includes(e.field));
      log("tool.register.rejected", {
        summary: result.errors.map((e) => e.field).join(", "),
        errors: result.errors,
        attempted: fields,
      });

      const exhausted = await registerFailures(context.callId, result.errors, fields);
      if (exhausted.length) {
        log("tool.give_up", { summary: exhausted.join(", "), call_id: context.callId });
        return giveUp(exhausted, context);
      }

      return {
        ok: false,
        saved: false,
        errors: firstErrors(result.errors),
        next_step: missing.length
          ? "Ask for the listed field(s) using the wording in `say`, then call registerPatient again with the full set of fields."
          : "Re-ask only for the listed field(s), then call registerPatient again with the full set of fields.",
      };
    }

    // The brief's observability requirement: the final collected payload, logged.
    log("patient.created", {
      source: "voice",
      summary: `${result.patient.display.full_name} (${result.patient.patient_id})`,
      patient: result.patient,
    });

    return {
      ok: true,
      saved: true,
      patient_id: result.patient.patient_id,
      first_name: result.patient.first_name,
      say: `You're all set, ${result.patient.first_name}. Your registration is saved.`,
      next_step:
        "Registration is stored. Optionally offer to schedule a first appointment, then thank them and end the call with the endCall tool.",
    };
  },

  /**
   * Update an existing record — the returning-caller path. Partial by design:
   * send only the fields the caller wants changed.
   */
  updatePatientRecord: async ({ patient_id, ...rest } = {}) => {
    if (!patient_id) {
      return {
        ok: false,
        message: "patient_id is required.",
        next_step: "Call lookupPatientByPhone first to get the patient_id.",
      };
    }

    const fields = pickFields(rest);
    if (!Object.keys(fields).length) {
      return {
        ok: false,
        message: "No fields to update were provided.",
        next_step: "Ask the caller which details they would like to change.",
      };
    }

    const result = await updatePatient(patient_id, fields);

    if (result.notFound) {
      return {
        ok: false,
        message: "No record with that patient_id.",
        next_step:
          "Tell the caller you couldn't find the record, and offer to register them as a new patient instead.",
      };
    }
    if (!result.ok) {
      log("tool.update.rejected", { summary: patient_id, errors: result.errors });
      return {
        ok: false,
        saved: false,
        errors: firstErrors(result.errors),
        next_step: "Re-ask only for the listed field(s), then call updatePatientRecord again.",
      };
    }

    log("patient.updated", {
      source: "voice",
      summary: `${result.patient.display.full_name} — ${result.changed.join(", ")}`,
      patient_id: result.patient.patient_id,
      changed: result.changed,
      patient: result.patient,
    });

    return {
      ok: true,
      saved: true,
      updated_fields: result.changed.map((f) => FIELD_LABELS[f]),
      say: `All updated, ${result.patient.first_name}.`,
      next_step: "Confirm what changed, then thank them and end the call with the endCall tool.",
    };
  },

  // --- Bonus: appointment scheduling (mock data) ---------------------------

  listAppointmentSlots: async () => {
    const slots = await listSlots();
    if (!slots.length) {
      return { count: 0, message: "No openings left. Tell the caller the office will follow up to schedule." };
    }
    return {
      count: slots.length,
      slots,
      next_step: "Offer at most two of these, using `spoken_date`. Don't read the whole list.",
    };
  },

  bookAppointment: async ({ slot_id, patient_id, patient_name } = {}) => {
    const result = await bookSlot({ slotId: slot_id, patientId: patient_id, patientName: patient_name });
    if (!result.ok) return { ok: false, message: result.message };

    log("appointment.booked", {
      summary: `${result.appointment.confirmation} ${result.appointment.date} ${result.appointment.time}`,
      appointment: result.appointment,
      patient_id: patient_id ?? null,
    });

    return {
      ok: true,
      confirmation: result.appointment.confirmation,
      spoken_date: result.appointment.spoken_date,
      time: result.appointment.time,
      provider: result.appointment.provider,
      next_step:
        "Confirm the day, time and provider. Read the confirmation code one character at a time, then end the call.",
    };
  },
};

/** Used by scripts/preflight.js to check the deployed schemas match this file. */
export const toolNames = Object.keys(tools);

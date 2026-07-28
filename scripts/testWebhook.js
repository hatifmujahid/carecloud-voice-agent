// scripts/testWebhook.js
// Exercises the voice agent's tools by POSTing the exact payload shapes Vapi
// sends, so the whole tool layer can be verified without spending call minutes.
//
//   npm run dev              # terminal 1
//   npm run test:webhook     # terminal 2
//
// Records created here use the 999 area code and are cleaned up at the end.

import "dotenv/config";

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const WEBHOOK = `${BASE}/vapi/webhook`;
const SECRET = process.env.VAPI_SERVER_SECRET;

let passed = 0;
let failed = 0;
let counter = 1;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
}

async function post(message, extraHeaders = {}) {
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SECRET ? { "x-vapi-secret": SECRET } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ message }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const CALL_ID = `test-call-${Date.now()}`;

/**
 * Build the `tool-calls` envelope. Arguments arrive from Vapi as a JSON
 * *string*, so they're sent that way here to keep the test honest — a server
 * that only handles pre-parsed objects would pass a sloppier test and fail live.
 */
async function callTool(name, args = {}, callId = CALL_ID) {
  const { status, body } = await post({
    type: "tool-calls",
    call: { id: callId },
    toolCallList: [
      { id: `call_${name}_${counter++}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  });

  if (status !== 200) throw new Error(`${name}: HTTP ${status} ${JSON.stringify(body)}`);
  const entry = body?.results?.[0];
  if (!entry) throw new Error(`${name}: no results[0] in ${JSON.stringify(body)}`);

  // Vapi requires a string result; anything else reaches the model as
  // "[object Object]". Assert that contract, then parse for readability.
  if (typeof entry.result !== "string") {
    throw new Error(`${name}: result must be a string, got ${typeof entry.result}`);
  }
  try {
    return JSON.parse(entry.result);
  } catch {
    return entry.result;
  }
}

/**
 * A unique but *valid* US number in the reserved 999 area code, so test records
 * are easy to spot and easy to clean up.
 *
 * The exchange digit is forced to 2-9: NANP forbids 0 or 1 there, and the
 * validator enforces it. A naive 7-random-digit generator produces an invalid
 * number roughly one run in five — a flaky test rather than a real failure.
 */
const uniquePhone = () => {
  const exchange = 2 + Math.floor(Math.random() * 8); // 2-9
  const rest = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `999${exchange}${rest}`;
};

const fullPatient = (phone) => ({
  first_name: "Voice",
  last_name: "Tester",
  date_of_birth: "05/17/1991",
  sex: "female",
  phone_number: phone,
  address_line_1: "42 Signal Street",
  city: "austin",
  state: "Texas",
  zip_code: "78701",
});

const createdIds = [];
const bookedSlotIds = [];

async function main() {
  console.log(`Testing ${WEBHOOK}\n`);

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check("GET /health is ok", health?.ok === true, health);

  // --- validateFields ------------------------------------------------------
  console.log("\nvalidateFields");
  const batch = await callTool("validateFields", {
    first_name: "jane",
    last_name: "D-A-V-I-S",
    date_of_birth: "March 4, 1990",
    sex: "female",
  });
  check("accepts a valid batch", batch?.ok === true, batch);
  check("joins spelled-out letters (D-A-V-I-S -> Davis)", batch?.normalized?.last_name === "Davis", batch?.normalized);
  check("normalizes a month-name date to ISO", batch?.normalized?.date_of_birth === "1990-03-04", batch?.normalized);
  check("maps loose sex input to the enum", batch?.normalized?.sex === "Female", batch?.normalized);
  check("returns a spoken date for readback",
    typeof batch?.spoken?.date_of_birth === "string" && batch.spoken.date_of_birth.includes("March"),
    batch?.spoken);

  const badDob = await callTool("validateFields", { date_of_birth: "01/01/2099" });
  check("rejects a future date of birth", badDob?.ok === false, badDob);
  check("names the offending field", badDob?.errors?.[0]?.field === "date_of_birth", badDob?.errors);
  check("gives a speakable re-prompt",
    typeof badDob?.errors?.[0]?.say === "string" && badDob.errors[0].say.length > 10, badDob?.errors);

  const shortPhone = await callTool("validateFields", { phone_number: "555" });
  check("rejects a 3-digit phone number", shortPhone?.ok === false, shortPhone);
  check("re-prompt mentions the digit count",
    /10 digits/.test(shortPhone?.errors?.[0]?.say ?? ""), shortPhone?.errors);

  const errorCap = await callTool("validateFields", {
    date_of_birth: "nonsense", phone_number: "1", zip_code: "1", state: "ZZ", email: "x",
  });
  check("caps simultaneous errors at 2 to keep the agent focused",
    errorCap?.errors?.length === 2, errorCap?.errors?.length);

  const empty = await callTool("validateFields", {});
  check("empty batch is rejected", empty?.ok === false, empty);

  const spokenPhone = await callTool("validateFields", { phone_number: "(415) 555-0123" });
  check("strips phone formatting", spokenPhone?.normalized?.phone_number === "4155550123", spokenPhone?.normalized);
  check("returns grouped digits for TTS",
    spokenPhone?.spoken?.phone_number === "415, 555, 0123", spokenPhone?.spoken);

  // --- lookupPatientByPhone ------------------------------------------------
  console.log("\nlookupPatientByPhone");
  const phone = uniquePhone();
  const noMatch = await callTool("lookupPatientByPhone", { phone_number: phone });
  check("unregistered number reports found: false", noMatch?.found === false, noMatch);
  check("tells the agent what to do next", typeof noMatch?.next_step === "string", noMatch);

  // --- registerPatient -----------------------------------------------------
  console.log("\nregisterPatient");
  const incomplete = await callTool("registerPatient", { first_name: "Voice", phone_number: phone });
  check("incomplete record is not saved", incomplete?.saved === false, incomplete);
  check("reports which fields are missing", (incomplete?.errors ?? []).length > 0, incomplete?.errors);

  const registered = await callTool("registerPatient", fullPatient(phone));
  check("complete record is saved", registered?.saved === true, registered);
  check("returns a patient_id", Boolean(registered?.patient_id), registered);
  check("gives the agent a closing line",
    /you're all set/i.test(registered?.say ?? ""), registered?.say);
  createdIds.push(registered.patient_id);

  // --- Duplicate detection (bonus) -----------------------------------------
  console.log("\nduplicate detection");
  const dupLookup = await callTool("lookupPatientByPhone", { phone_number: phone });
  check("registered number is now found", dupLookup?.found === true, dupLookup);
  check("returns the existing name for the offer",
    dupLookup?.first_name === "Voice" && dupLookup?.last_name === "Tester", dupLookup);
  check("next_step scripts the update offer",
    /update your information/i.test(dupLookup?.next_step ?? ""), dupLookup?.next_step);

  const dupRegister = await callTool("registerPatient", fullPatient(phone));
  check("re-registering the same number is blocked", dupRegister?.duplicate === true, dupRegister);
  check("blocked duplicate is not saved", dupRegister?.ok === false, dupRegister);
  check("offers to update instead", /update it/i.test(dupRegister?.say ?? ""), dupRegister?.say);

  const forced = await callTool("registerPatient", {
    ...fullPatient(phone), first_name: "Second", allow_duplicate: true,
  });
  check("allow_duplicate overrides the guard", forced?.saved === true, forced);
  if (forced?.patient_id) createdIds.push(forced.patient_id);

  // --- updatePatientRecord -------------------------------------------------
  console.log("\nupdatePatientRecord");
  const updated = await callTool("updatePatientRecord", {
    patient_id: registered.patient_id,
    city: "Dallas",
    insurance_provider: "Aetna",
  });
  check("partial update is saved", updated?.saved === true, updated);
  check("reports the fields it changed in spoken labels",
    (updated?.updated_fields ?? []).includes("city"), updated?.updated_fields);

  const noId = await callTool("updatePatientRecord", { city: "Nowhere" });
  check("missing patient_id is rejected", noId?.ok === false, noId);
  check("tells the agent to look the caller up first",
    /lookupPatientByPhone/.test(noId?.next_step ?? ""), noId?.next_step);

  const badUpdate = await callTool("updatePatientRecord", {
    patient_id: registered.patient_id, zip_code: "12",
  });
  check("invalid update value is rejected", badUpdate?.saved === false, badUpdate);

  const unknownPatient = await callTool("updatePatientRecord", {
    patient_id: "2f1c8e4a-0000-4000-8000-000000000000", city: "Nowhere",
  });
  check("unknown patient_id is reported", unknownPatient?.ok === false, unknownPatient);
  check("offers to register them instead",
    /register/i.test(unknownPatient?.next_step ?? ""), unknownPatient?.next_step);

  const nothingToChange = await callTool("updatePatientRecord", { patient_id: registered.patient_id });
  check("update with no fields is rejected", nothingToChange?.ok === false, nothingToChange);

  // --- Appointments (bonus) ------------------------------------------------
  console.log("\nappointments");
  const slots = await callTool("listAppointmentSlots");
  check("returns open slots", Array.isArray(slots?.slots) && slots.slots.length > 0, slots);
  check("includes a spoken date", Boolean(slots?.slots?.[0]?.spoken_date), slots?.slots?.[0]);

  const slotId = slots.slots[0].slot_id;
  const booked = await callTool("bookAppointment", {
    slot_id: slotId, patient_id: registered.patient_id, patient_name: "Voice Tester",
  });
  check("books a slot", booked?.ok === true, booked);
  check("returns a confirmation code", Boolean(booked?.confirmation), booked);

  const doubleBooked = await callTool("bookAppointment", { slot_id: slotId });
  check("the same slot can't be booked twice", doubleBooked?.ok === false, doubleBooked);
  check("suggests offering another time", /remaining|another/i.test(doubleBooked?.message ?? ""), doubleBooked);

  const badSlot = await callTool("bookAppointment", { slot_id: "NOPE" });
  check("unknown slot is rejected", badSlot?.ok === false, badSlot);

  bookedSlotIds.push(slotId);

  // Bookings persist, so the slot has to be released or every run permanently
  // consumes one of the six on offer — including this suite's own runs.
  const cancelled = await fetch(`${BASE}/appointments/${slotId}`, { method: "DELETE" });
  check("booked slot can be cancelled", cancelled.status === 200, cancelled.status);

  const reopened = await callTool("listAppointmentSlots");
  check("cancelled slot is offered again",
    (reopened?.slots ?? []).some((s) => s.slot_id === slotId), reopened?.slots?.length);

  const cancelAgain = await fetch(`${BASE}/appointments/${slotId}`, { method: "DELETE" });
  check("cancelling twice -> 404", cancelAgain.status === 404, cancelAgain.status);

  // --- Error handling ------------------------------------------------------
  console.log("\nerror handling");
  const unknownTool = await callTool("notARealTool", {});
  check("unknown tool returns a spoken-safe error", unknownTool?.ok === false, unknownTool);

  const emptyArgs = await post({
    type: "tool-calls",
    toolCallList: [{ id: "call_bad_args", type: "function", function: { name: "validateFields", arguments: "{oops" } }],
  });
  check("unparseable arguments don't 500", emptyArgs.status === 200, emptyArgs);

  const parallel = await post({
    type: "tool-calls",
    call: { id: CALL_ID },
    toolCallList: [
      { id: "p1", type: "function", function: { name: "listAppointmentSlots", arguments: "{}" } },
      { id: "p2", type: "function", function: { name: "validateFields", arguments: JSON.stringify({ city: "Reno" }) } },
    ],
  });
  check("handles two tool calls in one batch", parallel.body?.results?.length === 2, parallel.body);
  check("echoes each toolCallId back",
    parallel.body?.results?.map((r) => r.toolCallId).join(",") === "p1,p2", parallel.body?.results);

  // --- Lifecycle messages --------------------------------------------------
  console.log("\nlifecycle");
  const legacy = await post({
    type: "function-call",
    functionCall: { name: "listAppointmentSlots", parameters: {} },
  });
  check("legacy function-call shape still works", legacy.status === 200, legacy);
  check("legacy result is a string", typeof legacy.body?.result === "string", typeof legacy.body?.result);

  const status = await post({ type: "status-update", status: "in-progress", call: { id: CALL_ID } });
  check("status-update returns 200", status.status === 200, status);

  // Transcript linking gets its own call id and its own fresh registration. The
  // main CALL_ID above deliberately registered twice (the allow_duplicate case),
  // and the server links a transcript to the *last* record the call touched — so
  // asserting against that call would be testing two behaviours at once.
  const LIFECYCLE_CALL = `${CALL_ID}-lifecycle`;
  const lifecyclePatient = await callTool(
    "registerPatient",
    fullPatient(uniquePhone()),
    LIFECYCLE_CALL
  );
  check("registration during the lifecycle call succeeded", lifecyclePatient?.saved === true, lifecyclePatient);
  createdIds.push(lifecyclePatient.patient_id);

  const report = await post({
    type: "end-of-call-report",
    call: { id: LIFECYCLE_CALL },
    endedReason: "customer-ended-call",
    analysis: { summary: "Caller registered as a new patient." },
    transcript: "AI: Are you looking to register?\nUser: Yes.",
  });
  check("end-of-call-report returns 200", report.status === 200, report);

  const calls = await fetch(`${BASE}/api/calls`).then((r) => r.json());
  const logged = (calls?.data?.calls ?? []).find((c) => c.call_id === LIFECYCLE_CALL);
  check("transcript is stored against the call", Boolean(logged), calls?.data?.calls?.length);
  check("transcript text is persisted", /register/i.test(logged?.transcript ?? ""), logged?.transcript);
  check("call summary is persisted", Boolean(logged?.summary), logged?.summary);
  check("transcript is linked to the patient registered on that call",
    logged?.patient_id === lifecyclePatient.patient_id,
    { got: logged?.patient_id, want: lifecyclePatient.patient_id });

  const unhandled = await post({ type: "speech-update", status: "started" });
  check("unhandled message type returns 200", unhandled.status === 200, unhandled);

  // --- Auth ----------------------------------------------------------------
  console.log("\nauth");
  if (SECRET) {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vapi-secret": "wrong" },
      body: JSON.stringify({ message: { type: "status-update", status: "x" } }),
    });
    check("bad secret is rejected with 401", res.status === 401, res.status);

    const missing = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { type: "status-update", status: "x" } }),
    });
    check("missing secret is rejected with 401", missing.status === 401, missing.status);
  } else {
    console.log("  SKIP  secret enforcement (VAPI_SERVER_SECRET not set — webhook is open)");
  }

  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Soft-delete the patients this run created and release any slot it booked, so
 * the demo data stays clean and repeated runs don't exhaust the schedule.
 */
async function cleanup() {
  for (const id of createdIds.filter(Boolean)) {
    await fetch(`${BASE}/patients/${id}`, { method: "DELETE" }).catch(() => {});
  }
  for (const slot of bookedSlotIds.filter(Boolean)) {
    await fetch(`${BASE}/appointments/${slot}`, { method: "DELETE" }).catch(() => {});
  }
}

main().catch(async (err) => {
  console.error(`\nTest run failed: ${err.message}`);
  console.error("Is the server running? Try: npm run dev");
  await cleanup().catch(() => {});
  process.exit(1);
});

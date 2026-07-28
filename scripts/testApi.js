// scripts/testApi.js
// Integration tests for the REST API. Runs against a live server, exercising the
// real SQLite file, so it proves the actual deployment path rather than a mock.
//
//   npm run dev          # terminal 1
//   npm run test:api     # terminal 2
//
// Every record it creates uses a phone number in the 999 area code and is
// soft-deleted at the end, so repeated runs don't pollute the demo data.

import "dotenv/config";

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let parsed;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/**
 * A unique but *valid* US number in the reserved 999 area code. The exchange
 * digit is forced to 2-9 because NANP forbids 0 or 1 there and the validator
 * enforces it — a naive 7-random-digit generator would fail about one run in five.
 */
const uniquePhone = () => {
  const exchange = 2 + Math.floor(Math.random() * 8); // 2-9
  const rest = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `999${exchange}${rest}`;
};

// A complete, valid patient. Individual tests clone and break one field.
const validPatient = () => ({
  first_name: "Testy",
  last_name: "McTest",
  date_of_birth: "07/04/1988",
  sex: "Other",
  phone_number: uniquePhone(),
  email: "testy@example.com",
  address_line_1: "1 Test Way",
  address_line_2: "Unit 2",
  city: "Testville",
  state: "Oregon", // full name — should normalize to OR
  zip_code: "970451234", // 9 digits — should normalize to ZIP+4
  insurance_provider: "Test Health",
  insurance_member_id: "th-99 001",
  preferred_language: "English",
  emergency_contact_name: "Kin McTest",
  emergency_contact_phone: "(999) 555-0100",
});

const createdIds = [];

async function main() {
  console.log(`Testing ${BASE}\n`);

  // --- Envelope & health ---------------------------------------------------
  console.log("envelope");
  const health = await call("GET", "/health");
  check("GET /health is ok", health.body?.ok === true, health.body);

  const list = await call("GET", "/patients");
  check("GET /patients returns 200", list.status === 200, list.status);
  check("response uses { data, error } envelope",
    list.body && "data" in list.body && list.body.error === null, list.body);
  check("data.patients is an array", Array.isArray(list.body?.data?.patients), list.body?.data);

  // --- Create --------------------------------------------------------------
  console.log("\nPOST /patients");
  const payload = validPatient();
  const created = await call("POST", "/patients", payload);
  check("valid patient returns 201", created.status === 201, created);

  const patient = created.body?.data;
  createdIds.push(patient?.patient_id);
  check("returns a UUID patient_id",
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(patient?.patient_id ?? ""), patient?.patient_id);
  check("created_at and updated_at are set", Boolean(patient?.created_at && patient?.updated_at), patient);
  check("deleted_at starts null", patient?.deleted_at === null, patient?.deleted_at);

  // Normalization is applied server-side, not just in the voice agent.
  check("state normalized to 2 letters (Oregon -> OR)", patient?.state === "OR", patient?.state);
  check("zip normalized to ZIP+4", patient?.zip_code === "97045-1234", patient?.zip_code);
  check("dob normalized to ISO", patient?.date_of_birth === "1988-07-04", patient?.date_of_birth);
  check("phone stored as bare digits", /^\d{10}$/.test(patient?.phone_number ?? ""), patient?.phone_number);
  check("emergency phone stripped of formatting",
    patient?.emergency_contact_phone === "9995550100", patient?.emergency_contact_phone);
  check("member id normalized", patient?.insurance_member_id === "TH-99001", patient?.insurance_member_id);
  check("display block is present for humans",
    patient?.display?.date_of_birth === "07/04/1988", patient?.display);

  // --- Validation ----------------------------------------------------------
  console.log("\nvalidation (422)");
  const cases = [
    ["future date of birth", { date_of_birth: "01/01/2099" }],
    ["impossible date", { date_of_birth: "02/30/1990" }],
    ["3-digit phone number", { phone_number: "555" }],
    ["invalid state", { state: "ZZ" }],
    ["bad zip", { zip_code: "123" }],
    ["bad email", { email: "nope" }],
    ["invalid sex", { sex: "Yes" }],
    ["digits in name", { first_name: "R2D2" }],
  ];

  for (const [label, override] of cases) {
    const res = await call("POST", "/patients", { ...validPatient(), ...override });
    const field = Object.keys(override)[0];
    const flagged = (res.body?.error?.details ?? []).some((d) => d.field === field);
    check(`${label} -> 422 naming ${field}`, res.status === 422 && flagged, res.body?.error);
  }

  const missing = await call("POST", "/patients", { first_name: "OnlyName" });
  check("missing required fields -> 422", missing.status === 422, missing.status);
  check("names every missing required field",
    (missing.body?.error?.details ?? []).length === 8, missing.body?.error?.details?.length);

  const badJson = await call("POST", "/patients", "{not json");
  check("malformed JSON -> 400", badJson.status === 400, badJson);

  // --- Read ----------------------------------------------------------------
  console.log("\nGET /patients/:id");
  const fetched = await call("GET", `/patients/${patient.patient_id}`);
  check("returns the created record", fetched.body?.data?.patient_id === patient.patient_id, fetched.status);

  const notFound = await call("GET", "/patients/2f1c8e4a-0000-4000-8000-000000000000");
  check("unknown UUID -> 404", notFound.status === 404, notFound.status);
  check("404 body has error, null data",
    notFound.body?.data === null && notFound.body?.error?.code === "not_found", notFound.body);

  const badId = await call("GET", "/patients/not-a-uuid");
  check("malformed id -> 400", badId.status === 400, badId.status);

  // --- Filters -------------------------------------------------------------
  console.log("\nfilters");
  const byLast = await call("GET", "/patients?last_name=mctest");
  check("?last_name is case-insensitive",
    byLast.body?.data?.patients?.some((p) => p.patient_id === patient.patient_id), byLast.status);

  const byPhoneFormatted = await call(
    "GET",
    `/patients?phone_number=${encodeURIComponent(`(${payload.phone_number.slice(0, 3)}) ${payload.phone_number.slice(3, 6)}-${payload.phone_number.slice(6)}`)}`
  );
  check("?phone_number matches despite formatting",
    byPhoneFormatted.body?.data?.count === 1, byPhoneFormatted.body?.data);

  const byDobUs = await call("GET", "/patients?date_of_birth=07/04/1988");
  const byDobIso = await call("GET", "/patients?date_of_birth=1988-07-04");
  check("?date_of_birth accepts MM/DD/YYYY and ISO alike",
    byDobUs.body?.data?.count === byDobIso.body?.data?.count &&
      byDobUs.body?.data?.count >= 1,
    { us: byDobUs.body?.data?.count, iso: byDobIso.body?.data?.count });

  const badFilter = await call("GET", "/patients?date_of_birth=banana");
  check("invalid filter -> 422", badFilter.status === 422, badFilter.status);

  const noMatch = await call("GET", "/patients?last_name=Nobodyhere");
  check("no matches -> 200 with empty list", noMatch.status === 200 && noMatch.body.data.count === 0, noMatch.body?.data);

  // --- Update --------------------------------------------------------------
  console.log("\nPUT /patients/:id");
  const updated = await call("PUT", `/patients/${patient.patient_id}`, {
    city: "Portland",
    insurance_provider: "New Health Co",
  });
  check("partial update returns 200", updated.status === 200, updated.status);
  check("changed field is updated", updated.body?.data?.city === "Portland", updated.body?.data?.city);
  check("untouched field is preserved",
    updated.body?.data?.first_name === "Testy", updated.body?.data?.first_name);
  check("updated_at moved forward",
    updated.body?.data?.updated_at >= patient.updated_at, {
      before: patient.updated_at, after: updated.body?.data?.updated_at,
    });
  check("created_at is unchanged",
    updated.body?.data?.created_at === patient.created_at, updated.body?.data?.created_at);

  const badUpdate = await call("PUT", `/patients/${patient.patient_id}`, { zip_code: "abc" });
  check("invalid update -> 422", badUpdate.status === 422, badUpdate.status);

  const blankRequired = await call("PUT", `/patients/${patient.patient_id}`, { first_name: "" });
  check("blanking a required field -> 422", blankRequired.status === 422, blankRequired.status);

  const clearOptional = await call("PUT", `/patients/${patient.patient_id}`, { address_line_2: "" });
  check("blanking an optional field clears it",
    clearOptional.status === 200 && clearOptional.body?.data?.address_line_2 === null,
    clearOptional.body?.data?.address_line_2);

  const updateMissing = await call("PUT", "/patients/2f1c8e4a-0000-4000-8000-000000000000", { city: "X" });
  check("update unknown id -> 404", updateMissing.status === 404, updateMissing.status);

  // --- Persistence ---------------------------------------------------------
  console.log("\npersistence");
  const reread = await call("GET", `/patients/${patient.patient_id}`);
  check("update survived a fresh read", reread.body?.data?.city === "Portland", reread.body?.data?.city);
  console.log("  NOTE  restart-survival is asserted by npm run test:persistence");

  // --- Soft delete ---------------------------------------------------------
  console.log("\nDELETE /patients/:id (soft)");
  const deleted = await call("DELETE", `/patients/${patient.patient_id}`);
  check("delete returns 200", deleted.status === 200, deleted.status);
  check("deleted_at is set, not removed", Boolean(deleted.body?.data?.deleted_at), deleted.body?.data);

  const afterDelete = await call("GET", `/patients/${patient.patient_id}`);
  check("soft-deleted record is hidden from GET by id", afterDelete.status === 404, afterDelete.status);

  const listAfter = await call("GET", "/patients?last_name=McTest");
  check("soft-deleted record is hidden from the list",
    !listAfter.body.data.patients.some((p) => p.patient_id === patient.patient_id), listAfter.body?.data?.count);

  const withDeleted = await call("GET", "/patients?last_name=McTest&include_deleted=true");
  check("?include_deleted=true still returns it",
    withDeleted.body.data.patients.some((p) => p.patient_id === patient.patient_id),
    withDeleted.body?.data?.count);

  const deleteAgain = await call("DELETE", `/patients/${patient.patient_id}`);
  check("deleting twice -> 404", deleteAgain.status === 404, deleteAgain.status);

  // --- Unknown routes ------------------------------------------------------
  console.log("\nrouting");
  const noRoute = await call("GET", "/api/nonsense");
  check("unknown API route -> 404 envelope",
    noRoute.status === 404 && noRoute.body?.error?.code === "no_route", noRoute.body);

  const apiPrefix = await call("GET", "/api/patients");
  check("/api prefix serves the same router", apiPrefix.status === 200, apiPrefix.status);

  // --- Cleanup -------------------------------------------------------------
  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Soft-delete anything this run created but didn't already remove. */
async function cleanup() {
  for (const id of createdIds.filter(Boolean)) {
    await call("DELETE", `/patients/${id}`).catch(() => {});
  }
}

main().catch(async (err) => {
  console.error(`\nTest run failed: ${err.message}`);
  console.error("Is the server running? Try: npm run dev");
  await cleanup().catch(() => {});
  process.exit(1);
});

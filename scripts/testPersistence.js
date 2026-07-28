// scripts/testPersistence.js
// Proves the requirement the brief states most plainly: "If we register Jane Doe
// on Call 1, she must exist when we query on Call 2."
//
//   npm run test:persistence
//
// A same-process read would prove nothing — the driver could serve it from cache.
// So this writes a record, closes the connection, then re-executes itself as a
// *separate process* that connects cold and reads the record back. That's the
// boundary a server restart crosses, and also the boundary between two Vercel
// serverless invocations.

import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

// Both child modes connect cold, having inherited nothing from the parent but the
// connection string in the environment.
const verifyAt = process.argv.indexOf("--verify");
if (verifyAt !== -1) {
  const { getPatient } = await import("../src/patients.js");
  const patient = await getPatient(process.argv[verifyAt + 1]);
  // Communicate through stdout, the one channel that can't share memory.
  process.stdout.write(JSON.stringify(patient ? { found: true, patient } : { found: false }));
  process.exit(0);
}

const deleteAt = process.argv.indexOf("--delete");
if (deleteAt !== -1) {
  const { softDeletePatient } = await import("../src/patients.js");
  const result = await softDeletePatient(process.argv[deleteAt + 1]);
  process.stdout.write(JSON.stringify({ ok: result.ok === true }));
  process.exit(0);
}

// --- Parent: write, disconnect, re-read from a new process ------------------

const { createPatient } = await import("../src/patients.js");
const { closeDb, DB_DESCRIPTION } = await import("../src/db.js");

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

function runChild(...args) {
  const child = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: process.env });
  if (child.status !== 0) {
    console.error(`  child process failed: ${child.stderr}`);
    process.exit(1);
  }
  try {
    return JSON.parse(child.stdout);
  } catch {
    console.error(`  could not parse child output: ${child.stdout}`);
    process.exit(1);
  }
}

console.log(`Database: ${DB_DESCRIPTION}\n`);
console.log("call 1 — register");

// Reserved 999 area code, with the exchange digit forced to 2-9 (NANP forbids
// 0 and 1 there, and the validator enforces it).
const phone = `999${2 + Math.floor(Math.random() * 8)}${String(
  Math.floor(Math.random() * 1_000_000)
).padStart(6, "0")}`;
const created = await createPatient({
  first_name: "Jane",
  last_name: "Persistence",
  date_of_birth: "04/12/1985",
  sex: "Female",
  phone_number: phone,
  address_line_1: "1 Durable Way",
  city: "San Francisco",
  state: "CA",
  zip_code: "94102",
  insurance_provider: "Blue Shield",
});

check("record was created", created.ok === true, created.errors);
if (!created.ok) process.exit(1);

const id = created.patient.patient_id;
console.log(`        patient_id ${id}`);

await closeDb();
console.log("        connection closed (simulating a restart / new invocation)");

console.log("\ncall 2 — cold read from a separate process");
const result = runChild("--verify", id);

check("record survived the restart", result.found === true, result);
check("name is intact", result.patient?.display?.full_name === "Jane Persistence", result.patient?.display);
check("date of birth is intact", result.patient?.date_of_birth === "1985-04-12", result.patient?.date_of_birth);
check("phone number is intact", result.patient?.phone_number === phone, result.patient?.phone_number);
check("optional field is intact", result.patient?.insurance_provider === "Blue Shield", result.patient?.insurance_provider);
check("timestamps are intact", Boolean(result.patient?.created_at), result.patient?.created_at);

// Clean up from a third process. This also proves the database is still
// *writable* after the reconnect, not merely readable — the parent's own
// connection is closed, so re-importing the module here would reuse a dead one.
const cleanup = runChild("--delete", id);
check("record is still writable after reconnect (soft delete)", cleanup.ok === true, cleanup);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

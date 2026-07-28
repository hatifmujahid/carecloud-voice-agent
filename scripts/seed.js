// scripts/seed.js
// Inserts two demonstration patients so the API and dashboard have something to
// show before the first call. Idempotent: skips anyone already registered at the
// same phone number, so running it twice is safe.
//
//   npm run seed
//
// These are obviously fictional. Per the brief, no real patient data.

import "dotenv/config";
import { createPatient, findByPhone } from "../src/patients.js";
import { closeDb, DB_DESCRIPTION } from "../src/db.js";

const seeds = [
  {
    first_name: "Jane",
    last_name: "Doe",
    date_of_birth: "04/12/1985",
    sex: "Female",
    phone_number: "4155550142",
    email: "jane.doe@example.com",
    address_line_1: "1200 Market Street",
    address_line_2: "Apt 4B",
    city: "San Francisco",
    state: "CA",
    zip_code: "94102",
    insurance_provider: "Blue Shield",
    insurance_member_id: "BS12345678",
    preferred_language: "English",
    emergency_contact_name: "John Doe",
    emergency_contact_phone: "4155550143",
  },
  {
    first_name: "Miguel",
    last_name: "Santos",
    date_of_birth: "11/30/1979",
    sex: "Male",
    phone_number: "2125550198",
    address_line_1: "88 Grand Avenue",
    city: "Brooklyn",
    state: "NY",
    zip_code: "11205",
    preferred_language: "Spanish",
  },
];

console.log(`Database: ${DB_DESCRIPTION}\n`);

let created = 0;
let skipped = 0;

for (const seed of seeds) {
  if (await findByPhone(seed.phone_number)) {
    console.log(`  skip    ${seed.first_name} ${seed.last_name} — already registered`);
    skipped++;
    continue;
  }

  const result = await createPatient(seed);
  if (!result.ok) {
    // A seed that fails validation is a bug in this file, so make it loud.
    console.error(`  FAIL    ${seed.first_name} ${seed.last_name}`);
    for (const error of result.errors) console.error(`          ${error.field}: ${error.message}`);
    process.exitCode = 1;
    continue;
  }

  console.log(`  created ${result.patient.display.full_name}  ${result.patient.patient_id}`);
  created++;
}

console.log(`\n${created} created, ${skipped} already present.`);
await closeDb();

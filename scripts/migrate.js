// scripts/migrate.js
// Creates the collections, schema validators and indexes. Run once against a
// fresh MongoDB database:
//
//   npm run migrate
//
// The app also calls migrate() lazily (memoized, once per process), so this script
// isn't strictly required — but running it explicitly means a misconfigured
// MONGODB_URI fails here, with a clear message, rather than on the first phone
// call.

import "dotenv/config";
import { closeDb, CONFIG_ERROR, db, DB_DESCRIPTION, migrate } from "../src/db.js";

if (CONFIG_ERROR) {
  console.error(`\n${CONFIG_ERROR}\n`);
  process.exit(1);
}

console.log(`Database: ${DB_DESCRIPTION}`);

try {
  await migrate();
  console.log("\nCollections, validators and indexes applied.\n");

  const database = await db();
  for (const { name } of await database.listCollections({}, { nameOnly: true }).toArray()) {
    const collection = database.collection(name);
    const count = await collection.countDocuments();
    const indexes = await collection.indexes();
    const validated = await hasValidator(database, name);
    console.log(
      `  ${name.padEnd(14)} ${String(count).padStart(4)} doc(s)   ` +
        `${indexes.length} index(es)   validator: ${validated ? "yes" : "no"}`
    );
  }
} catch (err) {
  console.error(`\nMigration failed: ${err.message}`);
  console.error("Check MONGODB_URI, and that your Atlas IP allowlist includes this machine.\n");
  process.exitCode = 1;
}

/** Whether a schema validator is actually attached (it needs the dbAdmin role). */
async function hasValidator(database, name) {
  const [info] = await database.listCollections({ name }).toArray();
  return Boolean(info?.options?.validator);
}

await closeDb();

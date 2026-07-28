// scripts/migrate.js
// Creates the schema. Run once against a fresh Turso database:
//
//   npm run migrate
//
// The app also calls migrate() lazily (memoized, once per process), so this
// script isn't strictly required — but running it explicitly means a
// misconfigured DATABASE_URL fails here, with a clear message, rather than on the
// first phone call.

import "dotenv/config";
import { closeDb, DB_DESCRIPTION, IS_REMOTE, migrate, query } from "../src/db.js";

console.log(`Database: ${DB_DESCRIPTION}`);
if (!IS_REMOTE) {
  console.log("(local file — set DATABASE_URL to a libsql:// URL for production)");
}

try {
  await migrate();
  console.log("\nSchema applied.");

  const tables = await query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  for (const { name } of tables) {
    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM "${name}"`);
    console.log(`  ${name.padEnd(14)} ${n} row(s)`);
  }
} catch (err) {
  console.error(`\nMigration failed: ${err.message}`);
  console.error("Check DATABASE_URL and DATABASE_AUTH_TOKEN.\n");
  process.exitCode = 1;
}

closeDb();

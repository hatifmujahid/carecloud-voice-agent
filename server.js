// server.js
// Local development entry point: binds a port and keeps the process alive.
//
// Production runs on Vercel, where there is no long-lived process — api/index.js
// exports the same app as a serverless function instead. Both import src/app.js,
// so there is one app definition and no risk of the two drifting.

import "dotenv/config";
import app from "./src/app.js";
import { closeDb, DB_DESCRIPTION } from "./src/db.js";
import { migrate } from "./src/db.js";
import { log } from "./src/logger.js";

const PORT = process.env.PORT || 3000;

// Create the schema up front locally, so the first request isn't the thing that
// discovers the database is unreachable.
try {
  await migrate();
} catch (err) {
  console.error(`\nCould not reach the database (${DB_DESCRIPTION}):\n  ${err.message}\n`);
  console.error("Check DATABASE_URL / DATABASE_AUTH_TOKEN in .env.\n");
  process.exit(1);
}

// --- Stay alive ------------------------------------------------------------
// `node --watch` does NOT restart after a crash — it waits for a file change. An
// unexpected throw would silently take the webhook down mid-call and Vapi would
// just see timeouts. Log loudly and keep serving instead: a half-broken agent is
// far more debuggable than a dead one.

process.on("uncaughtException", (err) => {
  log("fatal.uncaught", { message: err.message, stack: err.stack });
});

process.on("unhandledRejection", (reason) => {
  log("fatal.unhandled_rejection", { message: String(reason) });
});

const server = app.listen(PORT, () => {
  console.log(`\nCareCloud patient registration service on :${PORT}`);
  console.log(`  database   ${DB_DESCRIPTION}`);
  console.log(`  webhook    POST /vapi/webhook`);
  console.log(`  api        GET  /patients`);
  console.log(`  dashboard  http://localhost:${PORT}/dashboard\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use — another server is still running.`);
    console.error("Find and stop it, then try again:");
    console.error(
      `  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*server.js*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
    );
    console.error(`Or run on a different port:  $env:PORT=3001; npm run dev\n`);
    process.exit(1);
  }
  log("server.error", { message: err.message });
});

// Release the port and close the database cleanly so an immediate restart doesn't
// EADDRINUSE or leave a stale WAL behind.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 3000).unref();
  });
}

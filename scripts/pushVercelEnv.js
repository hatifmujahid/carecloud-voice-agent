// scripts/pushVercelEnv.js
// Copies the environment variables this app needs from .env into a Vercel
// project, so they don't have to be typed into the dashboard one at a time.
//
//   npx vercel login && npx vercel link
//   npm run vercel:env
//
// Only the keys listed below are sent. PORT and LOG_FILE are deliberately
// excluded: Vercel assigns the port itself, and its filesystem is read-only so a
// log file would be silently disabled anyway.
//
// Re-runnable: an existing value is removed before the new one is added, because
// `vercel env add` refuses to overwrite.

import "dotenv/config";
import { spawnSync } from "node:child_process";

const KEYS = [
  { name: "MONGODB_URI", required: true },
  { name: "MONGODB_DB", required: false },
  { name: "VAPI_API_KEY", required: true },
  { name: "VAPI_SERVER_SECRET", required: false },
  { name: "VAPI_ASSISTANT_ID", required: false },
  { name: "SERVER_URL", required: true },
  { name: "LLM_MODEL", required: false },
  { name: "TRANSCRIBER_MODEL", required: false },
  { name: "VOICE_PROVIDER", required: false },
  { name: "VOICE_ID", required: false },
];

const TARGETS = ["production", "preview", "development"];

// `vercel` is used via npx so no global install is needed.
function vercel(args, input) {
  return spawnSync("npx", ["--yes", "vercel", ...args], {
    input,
    encoding: "utf8",
    shell: process.platform === "win32", // npx.cmd needs a shell on Windows
  });
}

// --- Preconditions ---------------------------------------------------------

const whoami = vercel(["whoami"]);
if (whoami.status !== 0) {
  console.error("\nNot logged in to Vercel. Run this first:\n\n  npx vercel login\n");
  process.exit(1);
}
console.log(`Vercel account: ${whoami.stdout.trim()}`);

const link = vercel(["project", "ls"]);
if (link.status !== 0) {
  console.error("\nThis directory isn't linked to a Vercel project. Run:\n\n  npx vercel link\n");
  process.exit(1);
}

// --- Push ------------------------------------------------------------------

let pushed = 0;
let skipped = 0;
let failed = 0;

for (const { name, required } of KEYS) {
  const value = process.env[name];

  if (!value) {
    if (required) {
      console.log(`  MISSING  ${name} — required, but not set in .env`);
      failed++;
    } else {
      console.log(`  skip     ${name} (not set in .env)`);
      skipped++;
    }
    continue;
  }

  for (const target of TARGETS) {
    // Ignore the result: a "not found" removal is the normal case on first run.
    vercel(["env", "rm", name, target, "--yes"]);
    const add = vercel(["env", "add", name, target], value);
    if (add.status !== 0) {
      console.log(`  FAIL     ${name} (${target}): ${(add.stderr || "").trim().split("\n").pop()}`);
      failed++;
    }
  }

  // Values are never printed — several of these are credentials.
  console.log(`  set      ${name} (${value.length} chars) -> ${TARGETS.join(", ")}`);
  pushed++;
}

console.log(`\n${pushed} set, ${skipped} skipped, ${failed} failed.`);
if (failed) {
  console.log("Fix the above, then re-run. Nothing is printed in plaintext by design.");
  process.exitCode = 1;
} else {
  console.log("Now redeploy so the new values take effect:\n\n  npx vercel --prod\n");
}

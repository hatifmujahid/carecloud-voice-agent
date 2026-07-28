// scripts/preflight.js
// Checks every link in the chain before you place a call:
//
//   Vapi phone number -> assistant config -> tunnel -> local server -> tools -> database
//
// The failure mode this exists to catch: ngrok restarts, hands you a new URL,
// and the deployed assistant still points at the dead one. Calls then connect
// fine but every tool silently times out, which is miserable to debug by ear.
//
//   npm run preflight

import "dotenv/config";

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL;
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const SECRET = process.env.VAPI_SERVER_SECRET;

let problems = 0;
let warnings = 0;

const ok = (msg) => console.log(`  OK    ${msg}`);
const info = (msg) => console.log(`  ..    ${msg}`);
function bad(msg, fix) {
  problems++;
  console.log(`  FAIL  ${msg}`);
  if (fix) console.log(`        -> ${fix}`);
}
function warn(msg, fix) {
  warnings++;
  console.log(`  WARN  ${msg}`);
  if (fix) console.log(`        -> ${fix}`);
}

const vapi = (path) =>
  fetch(`https://api.vapi.ai${path}`, {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
    signal: AbortSignal.timeout(15000),
  });

// --- 1. Config -------------------------------------------------------------
console.log("\nconfig");
if (VAPI_API_KEY) ok("VAPI_API_KEY is set");
else bad("VAPI_API_KEY missing", "Vapi dashboard -> Organization -> API Keys (private key)");

if (SERVER_URL) {
  if (SERVER_URL.startsWith("https://") && SERVER_URL.endsWith("/vapi/webhook")) {
    ok(`SERVER_URL -> ${SERVER_URL}`);
  } else {
    bad(`SERVER_URL must be an https URL ending in /vapi/webhook (got ${SERVER_URL})`, "Fix the scheme/path");
  }
} else {
  bad("SERVER_URL missing", "Set it to your public https URL + /vapi/webhook");
}

if (ASSISTANT_ID) ok(`VAPI_ASSISTANT_ID -> ${ASSISTANT_ID}`);
else info("VAPI_ASSISTANT_ID blank — deploy:assistant will CREATE a new assistant");

if (SECRET) ok("VAPI_SERVER_SECRET set (webhook is authenticated)");
else warn("VAPI_SERVER_SECRET blank — the webhook accepts requests from anyone", "Set it in .env, then npm run deploy:assistant");

// Report the database target, credential-free. src/db.js owns the actual
// validation of the connection string.
const { CONFIG_ERROR, DB_DESCRIPTION } = await import("../src/db.js");
if (CONFIG_ERROR) bad(CONFIG_ERROR, "Set MONGODB_URI in .env and in the host's environment");
else ok(`MONGODB_URI -> ${DB_DESCRIPTION}`);

// --- 2. Local server -------------------------------------------------------
console.log("\nlocal server");
let localUp = false;
try {
  const res = await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(3000) });
  const body = await res.json();
  if (body?.ok) {
    ok(`listening on :${PORT}`);
    info(`database ${body.database}`);
    localUp = true;
  } else {
    bad(`/health returned ${JSON.stringify(body)}`);
  }
} catch {
  bad(`nothing responding on :${PORT}`, "npm run dev");
}

// --- 3. Database -----------------------------------------------------------
if (localUp) {
  console.log("\ndatabase");
  try {
    const res = await fetch(`http://localhost:${PORT}/api/stats`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    const count = body?.data?.patients;
    if (typeof count === "number") {
      ok(`readable — ${count} patient record(s)`);
      if (count === 0) info("empty; `npm run seed` adds two demo records");
    } else {
      bad(`unexpected /api/stats response: ${JSON.stringify(body)}`);
    }
  } catch (err) {
    bad(`database not readable (${err.message})`);
  }
}

// --- 4. Tunnel -------------------------------------------------------------
console.log("\ntunnel");
let liveTunnel = null;
try {
  const res = await fetch("http://localhost:4040/api/tunnels", { signal: AbortSignal.timeout(3000) });
  const { tunnels = [] } = await res.json();
  const https = tunnels.find((t) => t.public_url?.startsWith("https://")) ?? tunnels[0];
  if (https) {
    liveTunnel = https.public_url;
    ok(`ngrok up -> ${liveTunnel} (forwarding to ${https.config?.addr})`);
    if (https.config?.addr && !String(https.config.addr).endsWith(String(PORT))) {
      bad(`ngrok forwards to ${https.config.addr}, but the server is on :${PORT}`, `ngrok http ${PORT}`);
    }
  } else {
    bad("ngrok is running but has no tunnels");
  }
} catch {
  info("ngrok local API not reachable — skipping (fine if you deployed to a real host)");
}

// Only compare against the tunnel when SERVER_URL is actually *meant* to be the
// tunnel. Once deployed to a real host, a tunnel left running in another terminal
// is irrelevant — flagging it as "stale" would be a false alarm.
if (liveTunnel && SERVER_URL && /ngrok/i.test(SERVER_URL)) {
  const expected = `${liveTunnel}/vapi/webhook`;
  if (expected === SERVER_URL) ok("SERVER_URL matches the live tunnel");
  else
    bad(
      `SERVER_URL is stale.\n        .env:        ${SERVER_URL}\n        live tunnel: ${expected}`,
      "Update SERVER_URL in .env, then: npm run deploy:assistant"
    );
} else if (liveTunnel && SERVER_URL) {
  info("SERVER_URL points at a deployed host, not the tunnel — ignoring ngrok");
}

// --- 5. Public reachability ------------------------------------------------
if (SERVER_URL) {
  console.log("\npublic reachability");
  const base = SERVER_URL.replace(/\/vapi\/webhook$/, "");
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15000) });
    if (res.ok) ok("public URL reaches the server");
    else if (res.status === 502) bad("public URL returns 502 — tunnel is up but the server is down", "npm run dev");
    else bad(`public URL returned http ${res.status}`);
  } catch (err) {
    bad(`public URL unreachable (${err.message})`, "Is the tunnel/host still running?");
  }
}

// --- 6. Deployed assistant agrees with this code ---------------------------
if (VAPI_API_KEY && ASSISTANT_ID) {
  console.log("\ndeployed assistant");
  try {
    const res = await vapi(`/assistant/${ASSISTANT_ID}`);
    if (!res.ok) {
      bad(`Vapi returned ${res.status} for that assistant id`, "Re-run npm run deploy:assistant");
    } else {
      const a = await res.json();
      ok(`"${a.name}"`);
      ok(`model: ${a.model?.provider}/${a.model?.model}`);
      ok(`voice: ${a.voice?.provider}/${a.voice?.voiceId}`);
      ok(`transcriber: ${a.transcriber?.provider}/${a.transcriber?.model ?? "default"}`);

      // The two-files-must-agree check: schemas declared to the model vs the
      // functions this server can actually run.
      const declared = (a.model?.tools ?? []).map((t) => t.function?.name).filter(Boolean);
      const { tools } = await import("../tools.js");
      const implemented = Object.keys(tools);

      const missing = declared.filter((n) => !implemented.includes(n));
      const unused = implemented.filter((n) => !declared.includes(n));

      ok(`tools declared: ${declared.join(", ") || "(none)"}`);
      if (missing.length)
        bad(`declared to the model but NOT implemented in tools.js: ${missing.join(", ")}`, "Add them to tools.js");
      else ok("every declared tool is implemented");
      if (unused.length)
        warn(`implemented but not declared: ${unused.join(", ")}`, "Add the schema in deployAssistant.js, then redeploy");

      if (a.server?.url === SERVER_URL) ok("assistant webhook matches SERVER_URL");
      else
        bad(
          `assistant points at a different webhook.\n        assistant: ${a.server?.url}\n        .env:      ${SERVER_URL}`,
          "npm run deploy:assistant"
        );

      if (!a.endCallFunctionEnabled) warn("endCallFunctionEnabled is off — the agent can't hang up on its own");
    }
  } catch (err) {
    bad(`couldn't fetch the assistant (${err.message})`);
  }
}

// --- 7. A dialable phone number is attached --------------------------------
if (VAPI_API_KEY) {
  console.log("\nphone number");
  try {
    const res = await vapi("/phone-number");
    if (!res.ok) {
      warn(`couldn't list phone numbers (http ${res.status})`);
    } else {
      const numbers = await res.json();
      if (!Array.isArray(numbers) || numbers.length === 0) {
        bad("no phone number provisioned on this Vapi account", "Vapi dashboard -> Phone Numbers -> Buy Number");
      } else {
        for (const n of numbers) {
          const attached = n.assistantId === ASSISTANT_ID;
          const label = `${n.number ?? n.id}${n.provider ? ` (${n.provider})` : ""}`;
          if (attached) ok(`${label} -> this assistant. Call it.`);
          else if (!n.assistantId) warn(`${label} has no assistant attached`, "Vapi dashboard -> Phone Numbers -> assign this assistant");
          else info(`${label} -> a different assistant (${n.assistantId})`);
        }
        if (ASSISTANT_ID && !numbers.some((n) => n.assistantId === ASSISTANT_ID)) {
          bad("no number routes to this assistant — nobody can call it", "Attach one in the Vapi dashboard");
        }
      }
    }
  } catch (err) {
    warn(`couldn't check phone numbers (${err.message})`);
  }
}

// --- Summary ---------------------------------------------------------------
console.log("");
if (problems === 0) {
  console.log(`All clear${warnings ? ` (${warnings} warning(s))` : ""}. Place a real call, or use`);
  console.log("Vapi dashboard -> Assistants -> your assistant -> Talk to Assistant.");
  process.exit(0);
}
console.log(`${problems} problem(s)${warnings ? ` and ${warnings} warning(s)` : ""} — fix the FAIL lines above before calling.`);
process.exit(1);

// src/app.js
// Builds the Express app. Deliberately does NOT call listen(), so the same app
// serves two runtimes:
//
//   server.js      local development — binds a port
//   api/index.js   Vercel            — exported as a serverless function
//
// Transport concerns only: routing, webhook auth, and translating between Vapi's
// message envelope and a plain tool call. No business logic lives here.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tools } from "../tools.js";
import { api } from "./api.js";
import { getCallPatientId, linkCallToPatient, recordCall } from "./patients.js";
import { CONFIG_ERROR, DB_DESCRIPTION, ping } from "./db.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const VAPI_SECRET = process.env.VAPI_SERVER_SECRET; // optional shared secret

export const app = express();
app.use(express.json({ limit: "2mb" }));

// --- Health & static -------------------------------------------------------

/**
 * Health check that actually checks. It reports a bad database configuration or
 * an unreachable database as 503 with the reason, rather than letting every route
 * fail with a stack trace — which is what happens when connection setup is done
 * at import time.
 */
app.get("/health", async (_req, res) => {
  if (CONFIG_ERROR) {
    return res.status(503).json({ ok: false, database: DB_DESCRIPTION, error: CONFIG_ERROR });
  }
  const result = await ping();
  return res
    .status(result.ok ? 200 : 503)
    .json({ ok: result.ok, database: DB_DESCRIPTION, ...(result.ok ? {} : { error: result.error }) });
});

app.get("/", (_req, res) => res.redirect("/dashboard"));

// Browsers request these on every dashboard visit. Answering 204 keeps them out
// of the logs instead of generating a 404 envelope per page view.
app.get(["/favicon.ico", "/favicon.png"], (_req, res) => res.status(204).end());

// Served explicitly rather than left to express.static, which would 301
// /dashboard -> /dashboard/ and make a pasted URL or a curl look like a failure.
app.get("/dashboard", (_req, res) => res.sendFile(join(PUBLIC_DIR, "index.html")));
app.use("/dashboard", express.static(PUBLIC_DIR));

// --- Vapi webhook ----------------------------------------------------------

/**
 * If VAPI_SERVER_SECRET is set, Vapi attaches it to every request (configured in
 * scripts/deployAssistant.js) and anything without it is rejected. Left unset the
 * webhook is open, which is fine for local debugging but is called out as a
 * limitation in the README.
 */
function verifySecret(req, res, next) {
  if (!VAPI_SECRET) return next();
  if (req.header("x-vapi-secret") !== VAPI_SECRET) {
    log("webhook.rejected", { message: "bad or missing x-vapi-secret" });
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/vapi/webhook", verifySecret, async (req, res) => {
  const message = req.body?.message ?? {};
  const call = message.call ?? req.body?.call ?? {};
  const callId = call.id ?? null;

  // Vapi's per-call control URL lets the server speak a final line and hang up.
  // Used by the give-up path in tools.js, where relying on the model to end the
  // call would mean relying on the component that has already broken down.
  const controlUrl = call.monitor?.controlUrl ?? null;

  try {
    switch (message.type) {
      // Current tool-calling format.
      case "tool-calls": {
        const toolCalls = message.toolCallList ?? message.toolCalls ?? [];
        const results = await Promise.all(
          toolCalls.map((toolCall) => runToolCall(toolCall, { callId, controlUrl }))
        );
        return res.json({ results });
      }

      // Legacy single-function format, kept so an older assistant config still
      // works against this server.
      case "function-call": {
        const { name, parameters } = message.functionCall ?? {};
        const result = await invokeTool(name, parameters ?? {}, { callId, controlUrl });
        return res.json({ result: asToolResult(result) });
      }

      case "status-update":
        log("call.status", { summary: `${message.status ?? "?"}`, call_id: callId });
        return res.json({});

      case "end-of-call-report": {
        const patientId = await getCallPatientId(callId);
        const transcript = message.transcript ?? message.artifact?.transcript ?? null;
        const summary = message.analysis?.summary ?? message.summary ?? null;

        log("call.ended", {
          summary: `${message.endedReason ?? "unknown reason"}${
            patientId ? ` — registered ${patientId}` : " — no record created"
          }`,
          call_id: callId,
          patient_id: patientId,
          ended_reason: message.endedReason,
          call_summary: summary,
          transcript,
        });

        // Best effort: a transcript that fails to store must not look like a
        // failed registration.
        try {
          await recordCall({
            callId: callId ?? undefined,
            patientId,
            endedReason: message.endedReason,
            summary,
            transcript: typeof transcript === "string" ? transcript : JSON.stringify(transcript),
          });
        } catch (err) {
          log("call.transcript_failed", { message: err.message, call_id: callId });
        }

        return res.json({});
      }

      default:
        // assistant-request, transcript, speech-update, hang, etc. Vapi expects a
        // 200 for all of them.
        return res.json({});
    }
  } catch (err) {
    // Never leave the agent hanging: log loudly and return 200 with an empty body
    // so the call continues rather than stalling on a webhook timeout.
    log("webhook.error", { message: err.message, stack: err.stack, call_id: callId });
    return res.status(200).json({});
  }
});

/** Run one tool call from a `tool-calls` batch and shape Vapi's reply entry. */
async function runToolCall(toolCall, context) {
  const name = toolCall.function?.name ?? toolCall.name;
  const args = parseArgs(toolCall.function?.arguments ?? toolCall.arguments);
  const result = await invokeTool(name, args, context);
  return { toolCallId: toolCall.id, result: asToolResult(result) };
}

/**
 * Dispatch to tools.js. A throwing tool is converted into a spoken-recoverable
 * error rather than a 500 — mid-call, the caller needs a sentence, not silence.
 */
async function invokeTool(name, args, context = {}) {
  const { callId } = context;
  const tool = tools[name];
  if (!tool) {
    log("tool.unknown", { summary: name });
    return { ok: false, message: `Unknown tool: ${name}` };
  }

  log("tool.call", { summary: name, tool: name, args });

  try {
    // Context carries the call id (for per-call state such as how many times a
    // field has failed validation) and the control URL (to end the call).
    const result = await tool(args, context);

    // Remember which patient this call is about, for transcript linking. Stored
    // in the database rather than in memory because the next tool call in the
    // same conversation may be served by a different serverless instance.
    if (callId && result?.patient_id && result.ok !== false) {
      await linkCallToPatient(callId, result.patient_id).catch((err) =>
        log("call.link_failed", { message: err.message, call_id: callId })
      );
    }
    return result;
  } catch (err) {
    log("tool.error", { summary: `${name}: ${err.message}`, tool: name, stack: err.stack });
    return {
      ok: false,
      message:
        "Something went wrong on our end saving that. Apologize briefly, tell the caller their details were not saved, and offer to try once more.",
    };
  }
}

/**
 * Vapi feeds `result` to the model verbatim and requires a string — an object
 * arrives as "[object Object]" and the agent starts improvising.
 */
const asToolResult = (result) => (typeof result === "string" ? result : JSON.stringify(result));

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    log("tool.args_unparseable", { summary: String(raw).slice(0, 200) });
    return {};
  }
}

// --- REST API --------------------------------------------------------------
// Mounted twice on purpose: the brief documents `/patients`, while `/api/...` is
// the conventional prefix (and what Vercel's rewrite target looks like). Both
// work; it's the same router instance. Mounted last so its catch-all 404 doesn't
// shadow the routes above.

app.use("/api", api);
app.use("/", api);

export default app;

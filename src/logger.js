// src/logger.js
// Structured line logging to stdout, and optionally to a file when LOG_FILE is
// set. One JSON object per line so the output stays greppable when a call and an
// API request interleave.
//
// This covers the brief's observability requirement: every tool call the agent
// makes and every registration payload that gets written is logged.
//
// On Vercel the filesystem is read-only, so file logging is best-effort — it
// disables itself on the first failure rather than turning a logging problem into
// a failed request. Vercel captures stdout, which is the real log destination in
// production.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

let logFile = process.env.LOG_FILE ? resolve(process.env.LOG_FILE) : null;

if (logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
  } catch (err) {
    console.log(`[logger] file logging disabled (${err.code ?? err.message}); using stdout only`);
    logFile = null;
  }
}

export function log(event, data = {}) {
  const line = { at: new Date().toISOString(), event, ...data };

  // Human-scannable on the console — during a live call you're watching this
  // output, and a wall of raw JSON is hard to read at speed.
  const detail = data.summary ?? data.message ?? "";
  console.log(`[${event}]${detail ? ` ${detail}` : ""}`);

  const serialized = safeStringify(line);

  if (logFile) {
    try {
      appendFileSync(logFile, serialized + "\n");
      return;
    } catch (err) {
      console.log(`[logger] file logging disabled (${err.code ?? err.message})`);
      logFile = null;
    }
  }

  // Full payloads to stdout when there's no log file, so nothing is lost.
  if (Object.keys(data).length) console.log(`  ${serialized}`);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ at: new Date().toISOString(), event: "log-serialize-failed" });
  }
}

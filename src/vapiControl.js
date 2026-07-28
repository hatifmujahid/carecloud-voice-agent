// src/vapiControl.js
// Server-initiated call control.
//
// Vapi exposes a per-call control URL (`call.monitor.controlUrl`) that accepts a
// `say` message with `endCallAfterSpoken`. That lets the *server* speak a final
// sentence and hang up, rather than asking the model to call the endCall tool and
// hoping it complies.
//
// Why that matters here: the give-up path exists precisely for the case where the
// conversation has stopped working. Depending on the model to end the call
// correctly at exactly that moment is depending on the component that is already
// struggling. The same reasoning that moved attempt-counting out of the prompt
// applies to hanging up.
//
// Best-effort by design: if the control URL isn't available (a web-widget call, an
// older payload shape, a network blip) this returns false and the caller falls
// back to instructing the model to end the call. It never throws into a live call.

import { log } from "./logger.js";

/**
 * Speak a final message, then end the call.
 *
 * @param {string|null|undefined} controlUrl from `call.monitor.controlUrl`
 * @param {string} message what the caller hears before the line drops
 * @returns {Promise<boolean>} true if Vapi accepted the instruction
 */
export async function sayAndEndCall(controlUrl, message) {
  if (!controlUrl) return false;

  try {
    const res = await fetch(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "say",
        message,
        // Wait for the sentence to finish before hanging up — otherwise the caller
        // hears the line cut mid-word, which is worse than the loop we're avoiding.
        endCallAfterSpoken: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      log("call.control_failed", { message: `control url returned http ${res.status}` });
      return false;
    }

    log("call.ending", { summary: "server ended the call after repeated failures" });
    return true;
  } catch (err) {
    log("call.control_failed", { message: err.message });
    return false;
  }
}

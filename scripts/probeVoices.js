// scripts/probeVoices.js
// Finds which voice configs your Vapi account actually accepts.
//
// Voice availability depends on your plan and on which provider credentials you've
// attached, so the only reliable answer is empirical: try to create a throwaway
// assistant with each candidate voice, then delete whatever got created.
//
// Usage: node scripts/probeVoices.js

import "dotenv/config";

const VAPI_API_KEY = process.env.VAPI_API_KEY;
if (!VAPI_API_KEY) {
  console.error("Missing VAPI_API_KEY. Set it in .env.");
  process.exit(1);
}

const CANDIDATES = [
  // Vapi-provided voices — need no third-party credential.
  { provider: "vapi", voiceId: "Elliot" },
  { provider: "vapi", voiceId: "Kylie" },
  { provider: "vapi", voiceId: "Paige" },
  { provider: "vapi", voiceId: "Rohan" },
  { provider: "vapi", voiceId: "Savannah" },
  // Other providers, in rough order of "works without extra setup".
  { provider: "openai", voiceId: "alloy" },
  { provider: "openai", voiceId: "shimmer" },
  { provider: "deepgram", voiceId: "aura-asteria-en" },
  { provider: "deepgram", voiceId: "asteria" },
  { provider: "azure", voiceId: "andrew" },
  { provider: "playht", voiceId: "jennifer" },
  { provider: "cartesia", voiceId: "248be419-c632-4f23-adf1-5324ed7dbf1d" },
  // The original failing config, plus the capitalized spelling.
  { provider: "11labs", voiceId: "Rachel" },
  { provider: "11labs", voiceId: "rachel" },
];

const headers = {
  Authorization: `Bearer ${VAPI_API_KEY}`,
  "Content-Type": "application/json",
};

async function probe(voice) {
  const res = await fetch("https://api.vapi.ai/assistant", {
    method: "POST",
    headers,
    body: JSON.stringify({
      // Vapi caps assistant names at 40 chars; a long voiceId would blow the
      // limit and look like a voice rejection.
      name: "voice-probe",
      model: {
        provider: "openai",
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "probe" }],
      },
      voice,
    }),
  });

  const text = await res.text();
  if (res.ok) {
    const { id } = JSON.parse(text);
    // Clean up so probes don't litter the dashboard.
    await fetch(`https://api.vapi.ai/assistant/${id}`, { method: "DELETE", headers }).catch(
      () => {}
    );
    return { ok: true };
  }

  let reason = text;
  try {
    const parsed = JSON.parse(text);
    reason = Array.isArray(parsed.message) ? parsed.message.join("; ") : parsed.message ?? text;
  } catch {
    /* keep raw text */
  }
  return { ok: false, status: res.status, reason };
}

const working = [];

for (const voice of CANDIDATES) {
  const label = `${voice.provider} / ${voice.voiceId}`;
  try {
    const result = await probe(voice);
    if (result.ok) {
      working.push(voice);
      console.log(`  OK    ${label}`);
    } else {
      console.log(`  FAIL  ${label}  (${result.status}) ${String(result.reason).slice(0, 140)}`);
    }
  } catch (err) {
    console.log(`  ERR   ${label}  ${err.message}`);
  }
}

console.log("");
if (working.length === 0) {
  console.log("No candidate voices were accepted. Check the Voice Library in the Vapi");
  console.log("dashboard and copy an exact provider/voiceId pair into .env.");
  process.exit(1);
}

const best = working[0];
console.log(`${working.length} working voice(s). Recommended:\n`);
console.log(`  VOICE_PROVIDER=${best.provider}`);
console.log(`  VOICE_ID=${best.voiceId}`);
console.log("\nPut those in .env, then: npm run deploy:assistant");

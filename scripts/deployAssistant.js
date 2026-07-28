// scripts/deployAssistant.js
// Creates (or updates) the Vapi assistant: system prompt, voice, tool schemas,
// and the webhook URL pointing back at this server.
//
//   npm run deploy:assistant
//
// Set VAPI_ASSISTANT_ID in .env after the first run, or every run creates a
// duplicate assistant instead of updating the existing one.
//
// The tool schemas here must agree with the implementations in tools.js. That
// duplication is inherent to the platform — Vapi needs the JSON schema to tell
// the model what it may call, and the server needs the function to run it.
// `npm run preflight` cross-checks the two and fails if they drift.

import "dotenv/config";

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const SERVER_URL = process.env.SERVER_URL; // public URL of POST /vapi/webhook
const VAPI_SERVER_SECRET = process.env.VAPI_SERVER_SECRET;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

if (!VAPI_API_KEY) {
  console.error("Missing VAPI_API_KEY. Set it in .env (Vapi dashboard -> Organization -> API Keys -> Private).");
  process.exit(1);
}
if (!SERVER_URL) {
  console.error("Missing SERVER_URL (public https URL ending in /vapi/webhook).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------
// Prompt engineering notes — why it is shaped this way:
//
// 1. VOICE FIRST. The model's default register is written English: lists,
//    parentheses, field names. All of that sounds robotic through TTS, so the
//    style rules are stated before the task and kept concrete ("under 25
//    words", "never say address_line_1").
//
// 2. BATCHED COLLECTION. Asking sixteen questions one at a time is the single
//    biggest reason these agents feel like an IVR. Fields are grouped the way a
//    human intake coordinator would ask for them — name together, address in
//    one breath — and the agent is told to accept extra information the caller
//    volunteers out of order instead of re-asking for it.
//
// 3. THE SERVER OWNS TRUTH. The model is told not to judge validity itself but
//    to call validateFields and trust the result. Format rules live in
//    src/validation.js; duplicating them here would let the two disagree, and
//    LLMs are unreliable at arithmetic like "is this date in the future".
//
// 4. FAILURE IS SCRIPTED. Every tool returns a `say` or `errors[].say` string.
//    The prompt tells the agent to use that wording, which is what makes a
//    validation failure sound like a person asking again rather than an error.
//
// 5. NO SILENT DATA LOSS. Explicit rules: never claim something is saved unless
//    a tool returned saved:true, and never invent a value the caller didn't say.
//    These are the two failure modes that would make the system dishonest.

const SYSTEM_PROMPT = `
# Role

You are Riley, a patient intake coordinator for CareCloud Family Medicine. You
answer the phone and register new patients by collecting their demographic
information, then confirming and saving it. You are warm, efficient, and you
sound like a person who has done this job for years.

# How you speak

- Keep replies under about 25 words. This is a phone call, not a form.
- One question at a time, but group naturally related things into that one
  question ("Can I get your first and last name?").
- Plain spoken English. No bullet points, no markdown, no emoji, no field names.
  Never say "address_line_1" or "date_of_birth" — say "street address", "date of
  birth".
- Use brief acknowledgements and move on: "Got it." "Thanks." "Perfect."
  Don't repeat every answer back immediately; that gets tedious. Save the
  repeating for the confirmation at the end.
- Never read out a list of options unless the caller is stuck.
- Spell out anything easy to mishear when confirming: read phone numbers and ZIP
  codes as separate digits, and codes one character at a time.

# What you collect

Required — you cannot save without all of these:
first and last name, date of birth, sex, phone number, street address, city,
state, ZIP code.

Optional — do NOT walk through these one by one. Once the required fields are
done, offer them as a group, exactly once:
"I can also take your insurance information, an emergency contact, and your
preferred language. Would you like to add any of those?"
Then collect only what they say yes to. Optional fields are: email, apartment or
unit number, insurance provider, insurance member ID, preferred language,
emergency contact name, emergency contact phone.

For sex, ask naturally: "And for the form, do you identify as male or female? You
can also say other, or decline to answer." Accept whatever they say without
comment.

# The call, step by step

1. You have already greeted them. Find out if they want to register as a new
   patient. If they want something else (a doctor, billing, directions), tell
   them you can only help with new patient registration and offer to have
   someone call them back.

2. Get their phone number early — right after their name. Then immediately call
   lookupPatientByPhone.
   - If it returns found: true, follow the next_step it gives you. Someone at
     that number is already registered, so offer to update instead of starting
     over.
   - If found: false, carry on registering them as new.

3. Collect the required fields conversationally. Ask for the address in one go:
   "What's your street address, city, state, and ZIP?" Most callers give it all
   at once — take everything they offer and only ask for what's missing.

4. Call validateFields as you go, in batches — once after the name, date of
   birth and sex, and once after the address. Not after every single answer.
   - If it returns ok: true, keep the values from "normalized". Those are what
     will be saved.
   - If it returns errors, ask again for only those fields, using the wording in
     "say". Do not re-ask for anything else.

5. Offer the optional fields as the single grouped question above.

6. Confirm everything before saving. Read back every field you collected, in a
   natural run of short sentences, using the "spoken" versions from
   validateFields for dates, phone numbers and ZIP codes. Then ask: "Is all of
   that correct?"
   - Read back only fields you actually collected. Never mention a field the
     caller skipped.

7. When they confirm, call registerPatient with every field you have.
   - If it returns saved: true, tell them using the "say" wording.
   - If it returns errors, apologize briefly, ask again for just those fields,
     and call registerPatient again with the full set.
   - If it reports duplicate: true, follow its next_step.

8. Optionally offer a first appointment: "Would you like me to book your first
   visit while you're here?" Only if they say yes, call listAppointmentSlots,
   offer at most two times, then bookAppointment.

9. Thank them by first name and end the call using the endCall tool.

# Corrections

Callers correct themselves constantly. Treat every correction as authoritative
and immediate, whenever it arrives — even after the confirmation readback.

- "Actually it's D-A-V-I-S, not Davies" — the spelled letters are the truth.
  Update that field, re-validate it, and read back just that one field: "Got it,
  Davis. D-A-V-I-S." Then carry on from where you were.
- If they correct something mid-readback, fix it, finish the readback, and ask
  for confirmation again.
- If they say "start over", "scratch that", or "let's begin again", discard
  everything you have collected and begin the intake again from their name.
  Confirm you're doing it: "No problem, let's start fresh."
- If they go quiet or you didn't hear them, ask once more plainly. Don't guess.

# Rules you must not break

- Never say information is saved unless a tool returned saved: true. If a save
  fails, say so plainly and tell them what you'll do next. Silence or a false
  confirmation is the worst possible outcome.
- Never invent, autocomplete, or assume a value the caller did not say. That
  includes guessing a city from a ZIP code or a full name from a first name.
- Never decide for yourself whether a date, phone number, email or ZIP is valid.
  Call validateFields and use its answer. If it rejects something twice, ask the
  caller to spell or say it digit by digit.
- Do not give medical advice or discuss symptoms, diagnoses, or medications.
  Say you'll have a nurse call them back, and continue with the registration.
- Do not read back or confirm the caller's data to anyone who calls asking about
  someone else.

# Language

If the caller speaks Spanish or says something like "hablo español", switch to
Spanish for the rest of the call and set their preferred language to Spanish.
Keep using the same tools and the same field names in the tool calls — only what
you speak changes. The same applies to any other language you can speak fluently.
`.trim();

// ---------------------------------------------------------------------------
// TOOL SCHEMAS
// ---------------------------------------------------------------------------
// Descriptions double as instructions to the model, so they state the expected
// shape ("MM/DD/YYYY", "10 digits") even though src/validation.js accepts more
// than that. Being generous at the boundary and specific in the prompt gets the
// best of both.

const patientFieldProperties = {
  first_name: { type: "string", description: "Given name, as the caller said or spelled it." },
  last_name: { type: "string", description: "Family name. If the caller spelled it out, pass the spelled letters." },
  date_of_birth: { type: "string", description: "Date of birth as MM/DD/YYYY. Month names are also accepted." },
  sex: { type: "string", description: "One of: Male, Female, Other, Decline to Answer." },
  phone_number: { type: "string", description: "US phone number, 10 digits including area code." },
  email: { type: "string", description: "Email address. Optional." },
  address_line_1: { type: "string", description: "Street number and street name." },
  address_line_2: { type: "string", description: "Apartment, suite or unit. Optional." },
  city: { type: "string" },
  state: { type: "string", description: "US state — two-letter abbreviation or full name." },
  zip_code: { type: "string", description: "5-digit ZIP, or ZIP+4." },
  insurance_provider: { type: "string", description: "Insurance company name. Optional." },
  insurance_member_id: { type: "string", description: "Member or subscriber ID. Optional." },
  preferred_language: { type: "string", description: "Defaults to English if not given. Optional." },
  emergency_contact_name: { type: "string", description: "Full name of emergency contact. Optional." },
  emergency_contact_phone: { type: "string", description: "10-digit US phone for the emergency contact. Optional." },
};

const toolSchemas = [
  {
    type: "function",
    function: {
      name: "lookupPatientByPhone",
      description:
        "Check whether a patient is already registered at this phone number. Call this as soon as you have the caller's phone number, before collecting the rest of their details.",
      parameters: {
        type: "object",
        properties: { phone_number: patientFieldProperties.phone_number },
        required: ["phone_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validateFields",
      description:
        "Check and clean up a batch of collected fields before saving. Returns the exact values that will be stored, plus spoken versions to read back, or a specific question to ask again for any field that was wrong. Send several fields at once, not one per call.",
      parameters: { type: "object", properties: { ...patientFieldProperties } },
    },
  },
  {
    type: "function",
    function: {
      name: "registerPatient",
      description:
        "Save a new patient record. Only call this after the caller has confirmed the readback. Send every field collected during the call.",
      parameters: {
        type: "object",
        properties: {
          ...patientFieldProperties,
          allow_duplicate: {
            type: "boolean",
            description:
              "Only set true if the caller confirms they are a different person sharing a phone number with an existing patient.",
          },
        },
        required: [
          "first_name",
          "last_name",
          "date_of_birth",
          "sex",
          "phone_number",
          "address_line_1",
          "city",
          "state",
          "zip_code",
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updatePatientRecord",
      description:
        "Update an existing patient's record. Use for a returning caller identified by lookupPatientByPhone. Send only the fields being changed.",
      parameters: {
        type: "object",
        properties: {
          patient_id: { type: "string", description: "patient_id from lookupPatientByPhone." },
          ...patientFieldProperties,
        },
        required: ["patient_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listAppointmentSlots",
      description:
        "List open appointment times. Only call this if the caller said yes to booking a first visit.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "bookAppointment",
      description: "Book one of the open appointment slots for the caller.",
      parameters: {
        type: "object",
        properties: {
          slot_id: { type: "string", description: "slot_id from listAppointmentSlots." },
          patient_id: { type: "string", description: "patient_id returned by registerPatient." },
          patient_name: { type: "string" },
        },
        required: ["slot_id"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// ASSISTANT CONFIG
// ---------------------------------------------------------------------------

const assistant = {
  // Vapi caps assistant names at 40 characters.
  name: "CareCloud Patient Intake",

  firstMessage:
    "Thanks for calling CareCloud Family Medicine, this is Riley. Are you looking to register as a new patient?",

  model: {
    provider: "openai",
    model: process.env.LLM_MODEL || "gpt-4o",
    // Low but not zero: enough variation to sound human, not enough to start
    // improvising around the intake script or the tool contract.
    temperature: 0.4,
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    tools: toolSchemas,
  },

  voice: {
    // Voice availability is account-specific — a valid-looking ID from the docs
    // can still 400. `npm run probe:voices` reports what this account accepts.
    // vapi/Elliot needs no third-party provider credential.
    provider: process.env.VOICE_PROVIDER || "vapi",
    voiceId: process.env.VOICE_ID || "Elliot",
  },

  transcriber: {
    // Names, street names and spelled-out letters are the hard part of this
    // call. Deepgram's phonecall-tuned model is noticeably better on 8kHz audio
    // than the general one; `numerals` keeps digits as digits so the validators
    // see "4155550123" rather than "four one five...".
    provider: "deepgram",
    model: process.env.TRANSCRIBER_MODEL || "nova-2-phonecall",
    language: "en",
    numerals: true,
  },

  // Let the model hang up itself once registration is done, so the call ends on
  // a sentence rather than a timeout.
  endCallFunctionEnabled: true,
  endCallMessage: "Thanks for calling CareCloud. Take care.",

  // Interruption handling. The caller talking over a long readback is normal and
  // should stop the agent quickly; but a 0.2s "uh-huh" shouldn't derail it.
  startSpeakingPlan: {
    waitSeconds: 0.4, // let the caller finish a beat before replying
  },
  stopSpeakingPlan: {
    numWords: 2, // ignore one-word acknowledgements
    voiceSeconds: 0.2,
    backoffSeconds: 1,
  },

  // A dropped or silent call shouldn't hold a line open indefinitely.
  silenceTimeoutSeconds: 30,
  maxDurationSeconds: 900,

  // Only the messages this server actually handles.
  serverMessages: ["tool-calls", "status-update", "end-of-call-report"],

  // Produces the summary stored against the call record.
  analysisPlan: {
    summaryPlan: {
      enabled: true,
      messages: [
        {
          role: "system",
          content:
            "Summarize this patient registration call in 2-3 sentences: who called, which fields were collected, whether the record was saved, and anything that went wrong.",
        },
        { role: "user", content: "Transcript:\n\n{{transcript}}" },
      ],
    },
  },

  server: {
    url: SERVER_URL,
    ...(VAPI_SERVER_SECRET ? { secret: VAPI_SERVER_SECRET } : {}),
  },
};

// ---------------------------------------------------------------------------

const isUpdate = Boolean(ASSISTANT_ID);
const endpoint = isUpdate
  ? `https://api.vapi.ai/assistant/${ASSISTANT_ID}`
  : "https://api.vapi.ai/assistant";

const res = await fetch(endpoint, {
  method: isUpdate ? "PATCH" : "POST",
  headers: {
    Authorization: `Bearer ${VAPI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(assistant),
});

const body = await res.text();
if (!res.ok) {
  console.error(`\nVapi API error ${res.status}:\n${body}\n`);
  process.exit(1);
}

const data = JSON.parse(body);
console.log(`${isUpdate ? "Updated" : "Created"} assistant ${data.id}`);
console.log(`  name      ${data.name}`);
console.log(`  model     ${data.model?.provider}/${data.model?.model}`);
console.log(`  voice     ${data.voice?.provider}/${data.voice?.voiceId}`);
console.log(`  tools     ${(data.model?.tools ?? []).map((t) => t.function?.name).join(", ")}`);
console.log(`  webhook   ${data.server?.url}`);
if (!isUpdate) {
  console.log(`\nPaste this into .env so future runs update instead of duplicating:`);
  console.log(`  VAPI_ASSISTANT_ID=${data.id}`);
}

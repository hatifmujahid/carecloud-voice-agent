# CareCloud — Voice AI Patient Registration

A phone number you can call to register as a new patient. A voice agent collects
your demographics conversationally, reads them back for confirmation, saves them
to a persistent database, and a REST API exposes the records afterwards.

Built for the Voice AI Agent take-home assessment.

---

## Live demo

| | |
| --- | --- |
| **Phone number** | **+1 (984) 477-7167** |
| **API base URL** | `https://<your-project>.vercel.app` |
| **Dashboard** | `https://<your-project>.vercel.app/dashboard` |
| **Health check** | `https://<your-project>.vercel.app/health` |

Try it:

```bash
BASE=https://<your-project>.vercel.app

# Everyone registered so far
curl $BASE/patients

# Find a specific patient
curl "$BASE/patients?last_name=Doe"
curl "$BASE/patients?phone_number=(415)%20555-0142"
```

**What to try on the call:** register normally; give a deliberately bad date of
birth ("March 40th") or a 3-digit phone number; spell a correction ("actually
it's D-A-V-I-S"); say "let's start over" halfway through; then hang up and call
back from the same number to see it recognise you and offer to update instead.

---

## Architecture

```
   Caller
     │  PSTN
     ▼
┌─────────────────┐   speech ─► text ─► LLM ─► speech
│      Vapi       │   Deepgram nova-2-phonecall · GPT-4o · Vapi TTS
│  (telephony +   │
│   STT/TTS/LLM)  │
└────────┬────────┘
         │  HTTPS  POST /vapi/webhook   (tool calls, status, end-of-call report)
         ▼
┌──────────────────────────────────────────────────────────────┐
│  Vercel — api/index.js exports the Express app as a function │
│  src/app.js: routing, webhook auth, Vapi envelope only       │
└───────┬──────────────────────────────────────┬───────────────┘
        │                                      │
        ▼                                      ▼
┌────────────────┐                    ┌──────────────────┐
│   tools.js     │                    │   src/api.js     │
│ voice tools    │                    │  REST endpoints  │
└───────┬────────┘                    └────────┬─────────┘
        │                                      │
        └──────────────┬───────────────────────┘
                       ▼
            ┌─────────────────────┐
            │  src/patients.js    │  service layer — the only writer
            └──────┬───────┬──────┘
                   ▼       ▼
      ┌────────────────┐  ┌──────────────┐
      │ src/validation │  │  src/db.js   │──► Turso (libSQL, over HTTP)
      │  shared rules  │  │  schema      │
      └────────────────┘  └──────────────┘
```

### Separation of concerns

| Layer | File | Responsibility | Knows nothing about |
| --- | --- | --- | --- |
| Runtime | `server.js` / `api/index.js` | Bind a port locally; export a function on Vercel | everything else |
| Telephony | `src/app.js` | HTTP routing, webhook auth, unwrapping Vapi's envelope | patient rules |
| Conversation | `scripts/deployAssistant.js` | System prompt, voice, tool schemas | the database |
| Voice tools | `tools.js` | Turning tool calls into service calls; phrasing results for speech | SQL |
| Service | `src/patients.js` | The only code that reads or writes patient records | HTTP, Vapi |
| Validation | `src/validation.js` | Field rules + normalization, shared by both front doors | storage |
| Storage | `src/db.js` | Schema, constraints, connection | business rules |
| API | `src/api.js` | REST semantics: status codes, envelope, filters | validation details |

**The important decision:** the voice agent and the REST API are two front doors
onto one service layer. A record created by phone and one created by
`POST /patients` go through identical validation and identical database
constraints. The brief allowed the agent to call the REST API over HTTP instead;
invoking the service layer directly avoids a network hop mid-call and removes a
failure mode (the server needing to resolve its own public URL while a caller
waits).

`src/app.js` builds the app but never calls `listen()`. `server.js` binds a port
for local development; `api/index.js` exports the same app as a Vercel function.
One app definition, so the two runtimes can't drift.

---

## Tech stack, and why

| Layer | Choice | Why this one |
| --- | --- | --- |
| Telephony + STT/TTS | **Vapi** | Abstracts the whole media path, so the time went into the prompt, the tool contract and the data layer rather than an audio pipeline. Barge-in and endpointing are configurable rather than hand-built. |
| Transcriber | **Deepgram `nova-2-phonecall`** | The hard part of this call is names, street names and spelled-out letters over 8 kHz phone audio. The phonecall-tuned model is meaningfully better than the general one; `numerals: true` keeps digits as digits so validators see `4155550123`, not "four one five...". |
| LLM | **OpenAI GPT-4o** | Needs to follow a long structured intake prompt *and* a six-tool contract while sounding natural. `gpt-4o-mini` drifted off the readback step and skipped `lookupPatientByPhone` in testing; the latency cost is worth it. Configurable via `LLM_MODEL`. |
| Backend | **Node 22 + Express** | Vapi's webhook contract is plain JSON, and an Express app *is* a `(req, res)` handler — so the same code runs as a local server and as a Vercel function with no adapter. |
| Database | **Turso (libSQL)** | Keeps SQLite's dialect — the same `CHECK` constraints, `strftime`, and SQL — while moving storage over the network, which is what serverless requires. See below. |
| Hosting | **Vercel** | Requested. What that costs and how it's mitigated is documented under [trade-offs](#known-limitations-and-trade-offs). |
| Dashboard | Vanilla HTML + `fetch` | Zero dependencies, no build, served from Vercel's CDN rather than a function. |

### Why libSQL/Turso rather than a SQLite file

This is the decision Vercel forces. Vercel's filesystem is **read-only apart from
an ephemeral `/tmp`**, and each request may be served by a different instance. A
file-backed SQLite database there would:

- crash at import when creating its directory, or
- if pointed at `/tmp`, give every instance its own empty database — so "register
  Jane Doe on call 1, query her on call 2" fails, which is the requirement the
  brief states most plainly.

libSQL is SQLite's fork, so moving to Turso changed the *transport*, not the SQL:
the schema, the `CHECK` constraints and every query are unchanged. What did change
is that all database access became **async**, which is why the service layer is
async throughout.

One connection string covers both environments, so there's no separate local mode
to keep in sync:

```bash
DATABASE_URL=file:./data/patients.db      # local dev + tests, no account needed
DATABASE_URL=libsql://<db>.turso.io       # production, + DATABASE_AUTH_TOKEN
```

`src/db.js` picks the pure-HTTP client for remote URLs and the native driver for
local files, so the serverless bundle carries no native binary.

### Serverless also killed all in-process state

Two things that worked as in-memory variables had to move into the database,
because the next tool call in the same conversation may land on a different
instance:

- **The call → patient link** (used to attach a transcript to the record it
  created) is now a row in `calls`, written by `linkCallToPatient`.
- **Appointment bookings** are now rows in `appointments`, with `slot_id` as the
  primary key — so the *database* prevents two callers being offered the same
  slot, rather than an array that only one instance can see.

---

## Setup

Requires **Node 22**.

```bash
git clone <this repo>
cd carecloud-voice-agent
npm install

cp .env.example .env       # then fill in VAPI_API_KEY
npm run migrate            # create the schema
npm run seed               # optional: two demo patients
npm run dev                # http://localhost:3000
```

Local development needs no Turso account — the default `DATABASE_URL` is a plain
file.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `VAPI_API_KEY` | **yes** | Vapi private key. Dashboard → Organization → API Keys. |
| `SERVER_URL` | **yes** | Public HTTPS URL of the webhook, including the `/vapi/webhook` path. |
| `DATABASE_URL` | **yes in prod** | `file:./data/patients.db` locally; `libsql://…` on Vercel. |
| `DATABASE_AUTH_TOKEN` | **yes in prod** | Turso token. Not needed for a `file:` URL. |
| `VAPI_SERVER_SECRET` | recommended | Shared secret; the server rejects webhooks without a matching `x-vapi-secret`. Without it the webhook is open to anyone who learns the URL. |
| `VAPI_ASSISTANT_ID` | after first deploy | Set it, or every deploy creates a *duplicate* assistant instead of updating. |
| `PORT` | no | Local only. Default `3000`. |
| `LLM_MODEL` | no | Default `gpt-4o`. |
| `TRANSCRIBER_MODEL` | no | Default `nova-2-phonecall`. |
| `VOICE_PROVIDER` / `VOICE_ID` | no | Default `vapi` / `Elliot`, which needs no third-party voice credential. |
| `LOG_FILE` | no | Extra JSON log file. Ignored on Vercel (read-only FS); stdout is the log there. |
| `TEST_BASE_URL` | no | Point the test scripts at a deployed instance. |

No secrets are committed. `.env` is gitignored; `.env.example` documents every
variable with no values.

---

## Deploying to Vercel

**1. Create the database.**

```bash
npm i -g turso                      # or: brew install tursodatabase/tap/turso
turso auth login
turso db create carecloud
turso db show carecloud --url       # -> libsql://carecloud-<org>.turso.io
turso db tokens create carecloud    # -> the auth token
```

**2. Create the schema.** Point `.env` at Turso and run the migration once:

```bash
DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… npm run migrate
```

**3. Deploy.**

```bash
npm i -g vercel
vercel login
vercel --prod
```

**4. Set the environment variables** in the Vercel dashboard (Settings →
Environment Variables), or from the CLI:

```bash
for KEY in VAPI_API_KEY VAPI_SERVER_SECRET DATABASE_URL DATABASE_AUTH_TOKEN \
           SERVER_URL LLM_MODEL TRANSCRIBER_MODEL VOICE_PROVIDER VOICE_ID; do
  vercel env add $KEY production
done
vercel --prod          # redeploy so the new variables take effect
```

`SERVER_URL` must be `https://<your-project>.vercel.app/vapi/webhook`.

**5. Point the assistant at it and verify.**

```bash
npm run deploy:assistant     # pushes the new webhook URL to Vapi
npm run preflight            # checks every link in the chain
TEST_BASE_URL=https://<your-project>.vercel.app npm run test:webhook
```

Then attach a phone number to the assistant in the Vapi dashboard under **Phone
Numbers**. `npm run preflight` confirms a number actually routes to it.

### How the routing works

`vercel.json` has two rewrites. `/dashboard` is served from the CDN as a static
file (Vercel publishes `public/index.html` at `/index.html`), so a page view costs
no function invocation. Everything else — the Vapi webhook and the whole REST API
— goes to the single Express function in `api/index.js`. `public/**` is also
bundled into the function via `includeFiles`, so the Express `sendFile` route for
`/dashboard` works as a fallback.

The REST router is mounted at both `/` and `/api`, which means the documented
`/patients` paths and the conventional `/api/patients` paths both resolve —
useful given Vercel's rewrite target is `/api`.

---

## Testing

```bash
npm run dev             # terminal 1
npm test                # terminal 2 — all three suites
```

| Command | Asserts | Count |
| --- | --- | --- |
| `npm run test:persistence` | Data survives a restart: writes a record, closes the connection, re-reads it **from a separate process** — the same boundary two serverless invocations cross | 8 |
| `npm run test:api` | Every endpoint, both envelopes, all six status codes, filters, soft-delete semantics, server-side normalization | 53 |
| `npm run test:webhook` | Every voice tool, using real Vapi payload shapes (arguments as a JSON *string*), duplicate detection, transcript linking, appointment booking and cancellation, auth | 63 |

**124 assertions, all passing.** The webhook suite also runs against a deployed
instance:

```bash
TEST_BASE_URL=https://<your-project>.vercel.app npm run test:webhook
```

`test:webhook` is the fast feedback loop — it exercises the entire tool layer
without spending a call minute. Test records use the reserved `999` area code and
are soft-deleted on the way out; booked slots are released, so repeated runs don't
consume the schedule.

`npm run preflight` checks the links a test can't: that `SERVER_URL` isn't stale,
that the deployed assistant's declared tools all exist in `tools.js`, that a phone
number points at this assistant, and — specifically for this deployment — that
`DATABASE_URL` isn't a local file while `SERVER_URL` is a serverless host. That
last one is the mistake that silently loses every record and looks fine until the
reviewer calls back.

---

## REST API

Base: `/patients` (also mounted at `/api/patients`).

Every response uses the same envelope:

```json
{ "data": { }, "error": null }
{ "data": null, "error": { "code": "validation_failed", "message": "…", "details": [ ] } }
```

| Method | Path | Returns | Notes |
| --- | --- | --- | --- |
| `GET` | `/patients` | 200 | Filters: `?last_name=` (case-insensitive), `?date_of_birth=`, `?phone_number=`, `?include_deleted=true` |
| `GET` | `/patients/:id` | 200 · 400 · 404 | 400 if `:id` isn't a UUID |
| `POST` | `/patients` | 201 · 400 · 422 | 400 malformed JSON, 422 validation failure |
| `PUT` | `/patients/:id` | 200 · 400 · 404 · 422 | Partial updates allowed |
| `DELETE` | `/patients/:id` | 200 · 400 · 404 | **Soft** delete — sets `deleted_at`, keeps the row |
| `GET` | `/calls` | 200 | Call transcripts and summaries |
| `GET` | `/appointments` | 200 | Booked appointments |
| `DELETE` | `/appointments/:slot_id` | 200 · 404 | Cancel, releasing the slot back on offer |
| `GET` | `/stats` | 200 | Record count |

Filters are forgiving because clients aren't: `?date_of_birth=` accepts both
`03/04/1990` and `1990-03-04`, and `?phone_number=(415) 555-0123` matches the
stored digits.

```bash
curl -X POST localhost:3000/patients -H 'Content-Type: application/json' -d '{
  "first_name":"Ada","last_name":"Lovelace","date_of_birth":"12/10/1815",
  "sex":"Female","phone_number":"4155550100","address_line_1":"12 Analytical Way",
  "city":"London","state":"NY","zip_code":"10001"
}'
```

### Data model

All 19 fields from the brief, plus `deleted_at` for soft deletes. Constraints are
enforced **in the schema as well as in application code** — see `src/db.js`.

Two storage decisions, both normalized on the way in:

- `date_of_birth` is stored **ISO `YYYY-MM-DD`** so it sorts and range-queries
  correctly, and is a real date — `CHECK (date_of_birth IS strftime(...))` rejects
  `2023-02-30` at the database level. The brief specifies `MM/DD/YYYY`, which is
  an *input* format: accepted on input, and returned under `display` for humans.
- `phone_number` is stored as **10 bare digits** so lookups match regardless of
  how a caller or client formatted it.

Every response carries a `display` block with `MM/DD/YYYY` and `(415) 555-0123`
forms, so the dashboard and the spoken readback don't each reinvent formatting.

---

## Prompt engineering

The full prompt is in `scripts/deployAssistant.js`, with the reasoning for each
section in a comment block above it. The five decisions that mattered:

1. **Voice-first style rules come before the task.** The model's default register
   is written English — lists, parentheses, field names. Rules are concrete
   ("under about 25 words", "never say `address_line_1`") rather than "be
   conversational", which does nothing.

2. **Batched collection.** Asking sixteen questions one at a time is the single
   biggest reason these agents feel like an IVR. Fields are grouped the way a
   human coordinator asks — name together, whole address in one breath — and the
   agent is told to keep information volunteered out of order rather than
   re-asking for it.

3. **The server owns truth.** The agent is told *not* to judge whether a date or
   phone number is valid, but to call `validateFields` and trust the result. LLMs
   are unreliable at "is this date in the future", and duplicating format rules in
   the prompt would let the two definitions drift.

4. **Failure is scripted, not improvised.** Every tool returns a `say` or
   `errors[].say` string, and the prompt tells the agent to use that wording.
   That's what turns a validation failure into *"That date is in the future, so it
   can't be a date of birth. What year were you born?"* instead of a generic
   apology.

5. **Two rules that make it honest.** Never claim something is saved unless a tool
   returned `saved: true`; never invent a value the caller didn't say (including
   guessing a city from a ZIP). A false confirmation is the worst outcome this
   system can produce.

### Tool design

`validateFields` takes a **batch**, not one field. Validating per-field would add
a network round trip to every question and make the call feel sluggish; the agent
checks a group (name + DOB + sex, then the address) in one hop. Errors are also
capped at two per response — handing the model eight simultaneous problems makes
it either dump them all at the caller or pick one at random.

| Tool | Purpose |
| --- | --- |
| `lookupPatientByPhone` | Duplicate detection, called as soon as the phone number is known |
| `validateFields` | Batch validate/normalize mid-call; returns spoken forms for readback |
| `registerPatient` | The save. Re-validates everything; nothing partial is written |
| `updatePatientRecord` | Returning-caller path, partial by design |
| `listAppointmentSlots` / `bookAppointment` | Bonus: first-visit scheduling |

Adding a tool means editing **two files that must agree** — the schema in
`deployAssistant.js` and the implementation in `tools.js`. `npm run preflight`
cross-checks them and fails if they drift.

---

## Edge cases and resilience

| What goes wrong | What happens |
| --- | --- |
| Invalid date of birth (future, `02/30`, 2-digit year) | Rejected server-side with a field-specific spoken re-prompt. A 2-digit year is *asked about* rather than guessed — `'52` could be 1952 or 2052. |
| 3-digit phone number | Rejected, and the re-prompt names the digit count it heard. Also enforces NANP structure, which catches a transcript that dropped a digit. |
| Caller spells a correction ("D-A-V-I-S") | Detected and joined into `Davis`. Guarded so genuinely hyphenated names like `Anne-Marie` are untouched. |
| Caller says "start over" | Prompt instructs the agent to discard everything and restart from the name, confirming out loud. Nothing was written yet, so there's nothing to undo. |
| Database write fails | The tool catches it and returns text instructing the agent to apologize, state plainly that the details were **not** saved, and offer to retry. The caller never gets silence or a false confirmation. |
| A tool throws unexpectedly | `src/app.js` converts it to a spoken-recoverable message and still returns HTTP 200 — a webhook 500 would stall the call rather than degrade it. |
| Call drops mid-registration | Nothing partial is ever written, so there's no half-record. `end-of-call-report` logs the reason and stores the transcript. |
| Caller talks over the agent | `stopSpeakingPlan` interrupts on 2+ words, so a long readback can be cut off, but a one-word "mhm" doesn't derail it. |
| Same person calls twice | `lookupPatientByPhone` matches on phone number and the agent offers to update. `registerPatient` independently refuses to create a duplicate unless `allow_duplicate` is set. |
| Two callers want the same appointment slot | `slot_id` is the primary key, so the second insert fails and the agent is told to offer another time. |
| Tool calls land on different instances | All cross-call state is in the database, so it doesn't matter which instance serves which request. |
| Unauthenticated webhook request | 401 when `VAPI_SERVER_SECRET` is set. |

### Observability

Structured JSON, one object per line, to stdout (captured by Vercel's logs) and
optionally to `LOG_FILE` locally. Every tool call is logged with its arguments,
and every registration logs the **full final payload** — the brief's minimum bar:

```
[tool.call] registerPatient
[patient.created] Jane Doe (3942175b-cca6-47da-a5fb-09c377dd2171)
  {"at":"…","event":"patient.created","source":"voice","patient":{…}}
[call.ended] customer-ended-call — registered 3942175b-…
```

Call transcripts and GPT-generated summaries are stored in the `calls` table,
linked to the patient created on that call, and readable via `GET /calls`.

---

## Bonus items included

- **Duplicate detection** — returning callers recognised by phone number, offered an update.
- **Appointment scheduling** — offered after registration, with confirmation codes and cancellation.
- **Multi-language** — the prompt switches to Spanish on "hablo español" and records the preference.
- **Call transcripts** — stored per call and linked to the patient record.
- **Dashboard** — `/dashboard`, live-refreshing, all fields, HTML-escaped.
- **Automated tests** — 124 assertions across three suites.

---

## Known limitations and trade-offs

**Cold starts are the real cost of running this on Vercel.** A serverless function
that hasn't been hit recently takes roughly 1–3 seconds to wake, plus the first
Turso round trip. If that lands on a tool call, the caller hears silence
mid-sentence. Mitigations in place: `migrate()` is memoized so schema setup costs
one round trip per instance rather than per request, the dashboard is served from
the CDN so it never wakes the function, and `maxDuration` is 30s so a slow start
doesn't get killed halfway. What would actually fix it is a warm instance — a
long-running host (Fly.io, Railway) or Vercel's paid always-warm options. **This
is the main reason a container host would suit this workload better than
serverless**, and it's a deliberate, requested trade-off rather than an oversight.

- **Every database call is now a network round trip.** Turso is fast, but a local
  SQLite file was microseconds. It shows up as a few tens of milliseconds per tool
  call — acceptable on a phone call, but it is strictly slower than the file-backed
  version this replaced.
- **No authentication on the REST API.** Anyone with the URL can read and modify
  patient records. Unacceptable for real PHI; out of scope per the brief's explicit
  "no HIPAA" note, and the demo data is fictional. Would be API-key or JWT
  middleware in front of `src/api.js`.
- **`PUT` is a partial update, not a replace.** Strict REST says `PUT` replaces and
  `PATCH` merges. The brief asked for "partial updates allowed" on `PUT`, so that's
  what it does.
- **Appointment slots are generated, not managed.** Six slots across the next three
  days, regenerated relative to today so the demo never offers a past date. There's
  no real provider calendar behind it — the brief permits mock data.
- **Duplicate detection keys on phone number only.** Two family members sharing a
  landline will collide; the agent asks rather than assuming, and `allow_duplicate`
  is the escape hatch. Name + DOB matching would be better.
- **English-first validation.** Field rules assume US formats (states, ZIP, NANP
  phone numbers), which is what the brief specifies, so the Spanish path handles
  the *conversation* but not a non-US address.
- **No rate limiting or spend cap.** `maxDurationSeconds: 900` bounds a single
  call, but nothing bounds cost across many.
- **Turso's free tier** has row-read limits. Fine for a demo, not for volume.

## Next steps

In rough priority order, given more time:

1. **Warm the function, or move to a container.** Cold-start silence is the single
   biggest remaining threat to call quality.
2. **Auth on the REST API** — API-key middleware, then per-client scoping.
3. **Better duplicate matching** — phone *plus* name/DOB fuzzy match, so
   shared-number households resolve correctly.
4. **Unit tests for the validators** — currently covered end-to-end through the
   API, which is slower and less precise than testing `src/validation.js` directly.
5. **Idempotency keys on `POST /patients`** — so a retried write after a network
   blip can't create a second record.
6. **Structured call analytics** — completion rate, average duration, and which
   field most often needs a re-prompt. That last number is what would tell you
   where the prompt or the transcriber is actually losing people.

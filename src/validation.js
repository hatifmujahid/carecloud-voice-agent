// src/validation.js
// One validator per field, shared by the REST API and the voice tools so the
// two front doors can never disagree about what a valid patient looks like.
//
// Every validator does two jobs:
//
//   1. NORMALIZE — speech-to-text output is messy. The caller says "three four
//      nineteen ninety", "j smith at gmail dot com", "D-A-V-I-S", "California".
//      Normalizing here means the agent's prompt doesn't have to describe
//      formatting rules, and the database only ever sees canonical values.
//   2. VALIDATE — returning a `message` written to be *spoken aloud*, naming
//      the field and what was wrong, so the agent can re-prompt for exactly
//      that field (a scored requirement) instead of restarting the section.
//
// Contract: { ok: true, value } | { ok: false, message }

// --- Reference data --------------------------------------------------------

// 50 states + DC + the inhabited territories that appear in real US addresses.
const STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC", "washington dc": "DC",
  "puerto rico": "PR", guam: "GU", "virgin islands": "VI",
  "american samoa": "AS", "northern mariana islands": "MP",
};
const STATE_CODES = new Set(Object.values(STATES));

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

export const SEX_VALUES = ["Male", "Female", "Other", "Decline to Answer"];

// --- Generic helpers -------------------------------------------------------

// Basic input sanitization for every string that reaches the database: strip
// control characters (including any stray NUL) and collapse whitespace. Note
// this is not HTML escaping — the dashboard escapes at render time instead,
// because mangling a name on the way *in* would corrupt the record itself.
function clean(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .split("")
    .map((ch) => (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const digits = (raw) => clean(raw).replace(/\D/g, "");

const ok = (value) => ({ ok: true, value });
const fail = (message) => ({ ok: false, message });

// "D-A-V-I-S" / "d a v i s" -> "Davis".
// Callers spell surnames constantly, and STT renders that as separated single
// letters. Guarded to >= 2 single-letter tokens so genuinely hyphenated names
// ("Anne-Marie") and initials inside a name are left alone.
function joinSpelledLetters(text) {
  const tokens = text.split(/[\s.\-]+/).filter(Boolean);
  if (tokens.length >= 2 && tokens.every((t) => /^[A-Za-z]$/.test(t))) {
    const word = tokens.join("");
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return text;
}

// Only re-case when the caller's transcript is entirely one case; otherwise
// leave it alone so "McDonald" and "van der Berg" survive intact.
function titleCaseIfUniform(text) {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return text;
  return text.replace(/([A-Za-zÀ-ɏ]+)/g, (w) =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
}

// --- Field validators ------------------------------------------------------

function validateName(raw, label) {
  let value = clean(raw).replace(/[.]/g, "");
  if (!value) return fail(`I didn't catch the ${label}. Could you say it again?`);

  value = titleCaseIfUniform(joinSpelledLetters(value));

  if (value.length > 50) return fail(`Sorry, I think I misheard — could you give me just your ${label}?`);
  // Letters (incl. accented), spaces, hyphens, apostrophes. Digits are the
  // common STT failure here ("Smith 2" from a noisy line), so reject them.
  if (!/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ' -]*$/.test(value)) {
    return fail(`Sorry, I don't think I caught that properly. Could you spell your ${label} for me?`);
  }
  return ok(value);
}

export const validators = {
  first_name: (raw) => validateName(raw, "first name"),
  last_name: (raw) => validateName(raw, "last name"),

  // Accepts MM/DD/YYYY (the documented format), ISO YYYY-MM-DD, month names,
  // and bare MMDDYYYY. Stored as ISO.
  date_of_birth: (raw) => {
    const text = clean(raw);
    if (!text) return fail("I didn't get a date of birth. What is it, month, day, and year?");

    let y, m, d;
    let match;

    if ((match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
      [, y, m, d] = match.map(Number);
    } else if ((match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
      [, m, d, y] = match.map(Number);
    } else if ((match = text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) {
      m = MONTHS[match[1].toLowerCase()];
      d = Number(match[2]);
      y = Number(match[3]);
      if (!m) return fail(`I didn't recognize "${match[1]}" as a month. Could you say the date of birth again?`);
    } else if ((match = text.match(/^(\d{2})(\d{2})(\d{4})$/))) {
      [, m, d, y] = match.map(Number);
    } else if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$/.test(text)) {
      // Two-digit years are ambiguous (a '52 birth year could be 1952 or 2052),
      // so ask rather than guess.
      return fail("I need the full four-digit year. What year were you born?");
    } else {
      return fail("Sorry, I didn't quite catch that. Could you give me your date of birth as month, day, and year?");
    }

    if (m < 1 || m > 12) return fail(`There's no month ${m}. What's your date of birth?`);
    if (d < 1 || d > 31) return fail(`There's no day ${d} in that month. Could you repeat your date of birth?`);

    // Round-trip through a UTC date to reject impossible days like Feb 30 —
    // the Date constructor silently rolls those over into the next month.
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
      return fail("Sorry, that didn't come through as a real date. Could you say your date of birth once more?");
    }

    // Compare against today's UTC date only, so a birthday "today" is valid
    // regardless of the caller's timezone.
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    if (date.getTime() > todayUtc) {
      return fail("Sorry, I must have misheard — that came through as a future date. What year were you born?");
    }
    if (y < today.getUTCFullYear() - 130) {
      return fail("That would make you over 130 years old — I think I misheard the year. Could you repeat it?");
    }

    const pad = (n) => String(n).padStart(2, "0");
    return ok(`${y}-${pad(m)}-${pad(d)}`);
  },

  sex: (raw) => {
    const text = clean(raw).toLowerCase().replace(/[.]/g, "");
    if (!text) return fail("I didn't catch that. For the registration form, do you identify as male, female, other, or would you rather not say?");

    if (/^(m|male|man|boy)$/.test(text)) return ok("Male");
    if (/^(f|female|woman|girl)$/.test(text)) return ok("Female");
    if (/(decline|prefer not|rather not|not say|no comment|skip)/.test(text)) return ok("Decline to Answer");
    if (/(other|non-?binary|nonbinary|nb|intersex|queer|fluid)/.test(text)) return ok("Other");

    return fail("I can record male, female, other, or decline to answer. Which should I put down?");
  },

  phone_number: (raw) => validateUsPhone(raw, "phone number"),
  emergency_contact_phone: (raw) => validateUsPhone(raw, "emergency contact's phone number"),

  email: (raw) => {
    // Callers dictate addresses aloud: "j dot smith at gmail dot com".
    let value = clean(raw)
      .toLowerCase()
      .replace(/\s+(at|@)\s+/g, "@")
      .replace(/\s+dot\s+/g, ".")
      .replace(/\s+underscore\s+/g, "_")
      .replace(/\s+dash\s+/g, "-")
      .replace(/\s+/g, "")
      .replace(/\.$/, ""); // trailing period from a dictated sentence

    if (!value) return fail("I didn't catch the email address. Could you say it again?");
    if (value.length > 254) return fail("That email address came through longer than I expected — could you say it again?");
    // Deliberately pragmatic, not RFC 5322: one @, no whitespace, a dotted
    // domain with a 2+ character TLD. Catches every realistic mis-hear.
    if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/.test(value)) {
      return fail("Sorry, I didn't catch that whole email address. Could you spell it out for me, including the part after the at sign?");
    }
    return ok(value);
  },

  address_line_1: (raw) => {
    const value = clean(raw);
    if (!value) return fail("I didn't get the street address. What's your street number and street name?");
    if (value.length > 200) return fail("That street address came through longer than I expected — could you say it again?");
    return ok(value);
  },

  address_line_2: (raw) => {
    const value = clean(raw);
    if (value.length > 100) return fail("That apartment or unit came through longer than I expected — could you say it again?");
    return ok(value); // genuinely optional — empty is fine
  },

  city: (raw) => {
    const value = titleCaseIfUniform(clean(raw));
    if (!value) return fail("I didn't catch the city. What city is that?");
    if (value.length > 100) return fail("That city name came through longer than I expected — could you say it again?");
    if (!/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ.' -]*$/.test(value)) {
      return fail("Sorry, I didn't catch that clearly. Could you say just the city?");
    }
    return ok(value);
  },

  state: (raw) => {
    const text = clean(raw).replace(/[.]/g, "");
    if (!text) return fail("I didn't catch the state. Which state?");

    // Spelled aloud ("C-A") or said as a full name ("California").
    const collapsed = text.replace(/[\s-]/g, "").toUpperCase();
    if (collapsed.length === 2 && STATE_CODES.has(collapsed)) return ok(collapsed);

    const byName = STATES[text.toLowerCase()];
    if (byName) return ok(byName);

    if (collapsed.length === 2) {
      return fail(`${collapsed} doesn't sound like a US state to me — I may have misheard. Which state is it?`);
    }
    return fail(`Sorry, I didn't quite get the state. Could you say it once more?`);
  },

  zip_code: (raw) => {
    // "nine oh two one oh" arrives as spaced digits; hyphen matters for ZIP+4.
    const text = clean(raw).replace(/[^\d-]/g, "");
    const bare = text.replace(/\D/g, "");
    if (!bare) return fail("I didn't catch the ZIP code. What is it?");
    if (bare.length === 5) return ok(bare);
    if (bare.length === 9) return ok(`${bare.slice(0, 5)}-${bare.slice(5)}`);
    return fail(`Sorry, I caught ${bare.length} digits — a ZIP code needs 5, or 9 for ZIP plus four. Could you say it again?`);
  },

  insurance_provider: (raw) => {
    const value = clean(raw);
    if (value.length > 100) return fail("That insurance provider name came through longer than I expected — could you say it again?");
    return ok(value);
  },

  insurance_member_id: (raw) => {
    // Member IDs are dictated with spaces and dashes that aren't part of the ID.
    const value = clean(raw).toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!value) return ok("");
    if (value.length > 50) return fail("That member ID came through longer than I expected — could you say it again?");
    if (!/^[A-Z0-9-]+$/.test(value)) {
      return fail("Sorry, I didn't get all of that. Could you read the member ID out once more?");
    }
    return ok(value);
  },

  preferred_language: (raw) => {
    const value = titleCaseIfUniform(clean(raw));
    if (!value) return ok("English"); // documented default
    if (value.length > 50) return fail("That language name came through longer than I expected — could you say it again?");
    if (!/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ -]*$/.test(value)) {
      return fail("I didn't recognize that language. Which language do you prefer?");
    }
    return ok(value);
  },

  emergency_contact_name: (raw) => {
    const value = clean(raw).replace(/[.]/g, "");
    if (!value) return ok("");
    if (value.length > 100) return fail("That name came through longer than I expected — could you say it again?");
    if (!/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ' -]*$/.test(value)) {
      return fail("Sorry, I didn't catch that clearly. Could you give me just the first and last name?");
    }
    return ok(titleCaseIfUniform(value));
  },
};

// Both phone fields share these rules, so the message is parameterized.
function validateUsPhone(raw, label) {
  let d = digits(raw);
  if (!d) return fail(`I didn't catch the ${label}. What is it?`);

  // Callers often include the country code.
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);

  if (d.length !== 10) {
    return fail(`Sorry, I only caught ${d.length} digits — a US ${label} needs 10 digits including the area code. Could you say it once more?`);
  }
  // NANP structure: neither the area code nor the exchange may start with 0 or
  // 1. This is what catches a transcription that dropped or added a digit.
  if (/^[01]/.test(d)) return fail(`Sorry, I think I dropped a digit there. Could you give me the whole ${label} again, starting with the area code?`);
  if (/^[01]/.test(d.slice(3))) return fail(`Sorry, I don't think I got that right. Could you say all ten digits again?`);

  return ok(d);
}

// --- Field metadata --------------------------------------------------------

export const REQUIRED_FIELDS = [
  "first_name",
  "last_name",
  "date_of_birth",
  "sex",
  "phone_number",
  "address_line_1",
  "city",
  "state",
  "zip_code",
];

export const OPTIONAL_FIELDS = [
  "email",
  "address_line_2",
  "insurance_provider",
  "insurance_member_id",
  "preferred_language",
  "emergency_contact_name",
  "emergency_contact_phone",
];

export const WRITABLE_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

// Spoken labels, used in error messages and in the readback the caller hears.
export const FIELD_LABELS = {
  first_name: "first name",
  last_name: "last name",
  date_of_birth: "date of birth",
  sex: "sex",
  phone_number: "phone number",
  email: "email",
  address_line_1: "street address",
  address_line_2: "apartment or unit",
  city: "city",
  state: "state",
  zip_code: "ZIP code",
  insurance_provider: "insurance provider",
  insurance_member_id: "insurance member ID",
  preferred_language: "preferred language",
  emergency_contact_name: "emergency contact name",
  emergency_contact_phone: "emergency contact phone",
};

// --- Record-level validation ----------------------------------------------

/**
 * Validate and normalize a whole patient payload.
 *
 * @param {object} input
 * @param {{ partial?: boolean }} [options] partial=true skips the
 *        required-field check, for PUT and for mid-call field updates.
 * @returns {{ ok: true, value: object } | { ok: false, errors: Array<{field: string, message: string}> }}
 */
export function validatePatient(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ field: null, message: "Expected a JSON object describing the patient." }] };
  }

  const value = {};
  const errors = [];

  // Ignore unknown keys entirely rather than erroring: the LLM occasionally
  // invents a plausible extra field, and that shouldn't fail a whole write.
  for (const field of WRITABLE_FIELDS) {
    const provided = Object.prototype.hasOwnProperty.call(input, field);
    const rawValue = input[field];
    const isBlank = rawValue === null || rawValue === undefined || clean(rawValue) === "";

    if (!provided || isBlank) {
      if (REQUIRED_FIELDS.includes(field)) {
        // Blanking a required field is an error even on a partial update —
        // otherwise `{"first_name": ""}` would be silently ignored.
        if (provided) {
          errors.push({ field, message: `Your ${FIELD_LABELS[field]} can't be left blank.` });
        } else if (!partial) {
          errors.push({ field, message: `I still need your ${FIELD_LABELS[field]}.` });
        }
      } else if (provided) {
        value[field] = null; // an explicit blank clears an optional field
      }
      continue;
    }

    const result = validators[field](rawValue);
    if (result.ok) value[field] = result.value === "" ? null : result.value;
    else errors.push({ field, message: result.message });
  }

  if (errors.length) return { ok: false, errors };
  if (!partial && !value.preferred_language) value.preferred_language = "English";

  return { ok: true, value };
}

// --- Presentation ----------------------------------------------------------
// Storage formats are canonical; these turn them back into something a person
// reads or hears. Used by the API serializer, the dashboard, and the readback.

export function formatPhone(stored) {
  if (!stored) return null;
  const d = String(stored).replace(/\D/g, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : stored;
}

export function formatDob(stored) {
  if (!stored) return null;
  const m = String(stored).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : stored;
}

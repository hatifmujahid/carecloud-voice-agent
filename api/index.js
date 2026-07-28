// api/index.js
// Vercel serverless entry point. An Express app is already a (req, res) handler,
// so it can be exported directly — every route in src/app.js is served by this
// one function, selected by the catch-all rewrite in vercel.json.
//
// Note what is deliberately absent: no app.listen(), and no schema setup at
// import time. `migrate()` is memoized inside src/db.js and awaited by each
// service call, so a cold start pays for it once and warm invocations don't pay
// at all.

import "dotenv/config";
import app from "../src/app.js";

export default app;

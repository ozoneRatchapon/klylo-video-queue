/**
 * Worker route smoke test — drives the real HTTP endpoint against a running dev server.
 *
 *   npm run dev            # in another shell
 *   node --env-file=.env.local tests/worker_smoke.mjs
 *
 * Asserts the state machine in app/api/jobs/[id]/process/route.ts:
 *   - an unauthenticated call is rejected,
 *   - another user's job is invisible (RLS, surfaces as 404),
 *   - a queued job runs to done or failed, taking 5-15 s,
 *   - a job already `processing` cannot be retried,
 *   - two concurrent calls claim the job exactly once.
 *
 * Requires "Confirm email" to be OFF. Uses the anon key only.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon_key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const base_url = process.env.BASE_URL ?? "http://localhost:3000";

if (!url || !anon_key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  process.exit(1);
}

const BUCKET = "job-images";
const CHUNK_SIZE = 3180; // matches @supabase/ssr's createChunks default
const project_ref = new URL(url).hostname.split(".")[0];
const results = [];

function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Rebuilds the cookie @supabase/ssr would have written for this session. */
function session_cookie(session) {
  const json = JSON.stringify(session);
  const b64 = Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const value = `base64-${b64}`;
  const key = `sb-${project_ref}-auth-token`;

  if (value.length <= CHUNK_SIZE) return `${key}=${value}`;

  const chunks = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    chunks.push(`${key}.${chunks.length}=${value.slice(i, i + CHUNK_SIZE)}`);
  }
  return chunks.join("; ");
}

async function make_user(label) {
  const client = createClient(url, anon_key);
  const email = `worker-smoke-${label}-${crypto.randomUUID()}@klylo-smoke.dev`;
  const { data, error } = await client.auth.signUp({ email, password: `pw-${crypto.randomUUID()}` });
  if (error) throw new Error(`sign up ${label}: ${error.message}`);
  if (!data.session) {
    throw new Error(`sign up ${label}: no session — turn "Confirm email" off for this test.`);
  }
  return { client, user_id: data.user.id, cookie: session_cookie(data.session) };
}

const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

async function make_job(actor) {
  const image_path = `${actor.user_id}/${crypto.randomUUID()}.png`;
  const { error: upload_error } = await actor.client.storage
    .from(BUCKET)
    .upload(image_path, png, { contentType: "image/png" });
  if (upload_error) throw new Error(`upload: ${upload_error.message}`);

  const { data, error } = await actor.client
    .from("jobs")
    .insert({ user_id: actor.user_id, prompt: "worker smoke", image_path })
    .select("*")
    .single();
  if (error) throw new Error(`insert: ${error.message}`);
  return { ...data, image_path };
}

async function process_job(job_id, cookie) {
  const response = await fetch(`${base_url}/api/jobs/${job_id}/process`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Fail fast with a clear message if the dev server is not up.
try {
  await fetch(base_url, { method: "HEAD" });
} catch {
  console.error(`Cannot reach ${base_url} — start the dev server first (npm run dev).`);
  process.exit(1);
}

const owner = await make_user("owner");
const other = await make_user("other");
const cleanup = [];

// 1. No session at all.
const job_a = await make_job(owner);
cleanup.push([owner, job_a]);
const anon_call = await process_job(job_a.id, null);
check("unauthenticated call is rejected", anon_call.status === 401, `HTTP ${anon_call.status}`);

// 2. Another user's job is invisible under RLS, so the route reports it missing.
const cross_call = await process_job(job_a.id, other.cookie);
check("other user's job is not found", cross_call.status === 404, `HTTP ${cross_call.status}`);

// 3. Happy path: a queued job runs to a terminal status and actually sleeps 5-15 s.
const started = Date.now();
const run = await process_job(job_a.id, owner.cookie);
const elapsed_ms = Date.now() - started;
check(
  "queued job reaches a terminal status",
  run.status === 200 && ["done", "failed"].includes(run.body?.status),
  `HTTP ${run.status} status=${run.body?.status} in ${(elapsed_ms / 1000).toFixed(1)}s`,
);
check("worker sleeps 5-15 s", elapsed_ms >= 5_000 && elapsed_ms <= 20_000, `${(elapsed_ms / 1000).toFixed(1)}s`);

const { data: settled } = await owner.client
  .from("jobs")
  .select("status, result_url, error_message")
  .eq("id", job_a.id)
  .single();
check(
  "terminal row is consistent",
  settled?.status === "done"
    ? settled.result_url === job_a.image_path && settled.error_message === null
    : Boolean(settled?.error_message) && settled?.result_url === null,
  `status=${settled?.status}`,
);

// 4. Retry must be refused while the job is processing.
const job_b = await make_job(owner);
cleanup.push([owner, job_b]);
await owner.client.from("jobs").update({ status: "processing" }).eq("id", job_b.id);
const retry_call = await process_job(job_b.id, owner.cookie);
check(
  "processing job cannot be retried",
  retry_call.status === 409,
  `HTTP ${retry_call.status} ${retry_call.body?.error ?? ""}`,
);

// 5. Two concurrent calls: exactly one claims the job.
const job_c = await make_job(owner);
cleanup.push([owner, job_c]);
const [first, second] = await Promise.all([
  process_job(job_c.id, owner.cookie),
  process_job(job_c.id, owner.cookie),
]);
const codes = [first.status, second.status].sort();
check(
  "concurrent calls claim the job once",
  codes[0] === 200 && codes[1] === 409,
  `HTTP ${codes.join(" / ")}`,
);

// Cleanup.
for (const [actor, job] of cleanup) {
  await actor.client.from("jobs").delete().eq("id", job.id);
  await actor.client.storage.from(BUCKET).remove([job.image_path]);
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);

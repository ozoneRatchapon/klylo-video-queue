/**
 * Stale job reaper smoke test — run against a real Supabase project.
 *
 *   node --env-file=.env.local tests/reaper_smoke.mjs
 *
 * Requires `supabase/migrations/20260902170000_stale_job_reaper.sql` to have been run, and
 * "Confirm email" OFF in Authentication → Providers → Email.
 * Uses the anon key only. The reaper itself is `security definer` and revoked from every
 * client role, so this asserts its *effects* plus the fact that it cannot be called directly.
 *
 * Cron fires once a minute, so the wait below is up to ~2 minutes by design.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon_key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anon_key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  process.exit(1);
}

const BUCKET = "job-images";
const REAP_TIMEOUT_MS = 150_000;
const results = [];

function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function make_user() {
  const client = createClient(url, anon_key);
  const email = `reaper-smoke-${crypto.randomUUID()}@klylo-smoke.dev`;
  const { data, error } = await client.auth.signUp({ email, password: `pw-${crypto.randomUUID()}` });
  if (error) throw new Error(`sign up: ${error.message}`);
  if (!data.session) {
    throw new Error('sign up: no session returned — turn "Confirm email" off for this test.');
  }
  return { client, user_id: data.user.id };
}

/** Seeds a job, then forces it into `status` as of `age_seconds` ago. */
async function seed_job(actor, status, age_seconds) {
  const image_path = `${actor.user_id}/${crypto.randomUUID()}.png`;
  // 1x1 transparent PNG.
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );

  const { error: upload_error } = await actor.client.storage
    .from(BUCKET)
    .upload(image_path, png, { contentType: "image/png" });
  if (upload_error) throw new Error(`upload: ${upload_error.message}`);

  const { data: created, error: insert_error } = await actor.client
    .from("jobs")
    .insert({ user_id: actor.user_id, prompt: `reaper ${status} ${age_seconds}s`, image_path })
    .select("*")
    .single();
  if (insert_error) throw new Error(`insert: ${insert_error.message}`);

  const stamped = new Date(Date.now() - age_seconds * 1000).toISOString();
  const { data: aged, error: age_error } = await actor.client
    .from("jobs")
    .update({ status, updated_at: stamped })
    .eq("id", created.id)
    .select("*")
    .single();
  if (age_error) throw new Error(`backdate: ${age_error.message}`);

  return aged;
}

async function read_job(actor, id) {
  const { data } = await actor.client.from("jobs").select("*").eq("id", id).maybeSingle();
  return data;
}

const actor = await make_user();

// The backdate is what makes the whole suite possible, so assert it actually took.
const stale_processing = await seed_job(actor, "processing", 300);
const age_ms = Date.now() - new Date(stale_processing.updated_at).getTime();
check(
  "an explicit updated_at survives the trigger",
  age_ms > 240_000,
  `row is ${Math.round(age_ms / 1000)}s old`,
);

const stale_queued = await seed_job(actor, "queued", 300);
const fresh_processing = await seed_job(actor, "processing", 0);

// The reaper sees every row, so no client role may invoke it.
// An error alone is not enough: before the migration the call also fails, just because the
// function is missing. Only a permissions refusal proves `revoke execute` is doing the work.
const { error: rpc_error } = await actor.client.rpc("reap_stale_jobs");
const missing = /could not find the function/i.test(rpc_error?.message ?? "");
check(
  "the reaper is not callable by a client",
  Boolean(rpc_error) && !missing,
  missing
    ? "reap_stale_jobs() does not exist — run the reaper migration first"
    : (rpc_error?.message ?? "the call SUCCEEDED — execute was not revoked"),
);

console.log(`\nwaiting up to ${REAP_TIMEOUT_MS / 1000}s for cron to reap…`);
const deadline = Date.now() + REAP_TIMEOUT_MS;
let reaped_processing = null;
let reaped_queued = null;

while (Date.now() < deadline) {
  reaped_processing = await read_job(actor, stale_processing.id);
  reaped_queued = await read_job(actor, stale_queued.id);
  if (reaped_processing?.status === "failed" && reaped_queued?.status === "failed") {
    break;
  }
  await sleep(3_000);
}

const waited = Math.round((REAP_TIMEOUT_MS - (deadline - Date.now())) / 1000);

check(
  "a stranded `processing` job is failed",
  reaped_processing?.status === "failed",
  `status=${reaped_processing?.status} after ${waited}s`,
);
check(
  "it says the worker stopped responding",
  Boolean(reaped_processing?.error_message?.includes("stopped responding")),
  reaped_processing?.error_message ?? "",
);
check(
  "a stranded `queued` job is failed",
  reaped_queued?.status === "failed",
  `status=${reaped_queued?.status} after ${waited}s`,
);
check(
  "it says the job was never picked up",
  Boolean(reaped_queued?.error_message?.includes("never picked up")),
  reaped_queued?.error_message ?? "",
);

// `failed` is exactly the status JobCard offers Retry on — that is the whole point.
check(
  "both are now retryable",
  reaped_processing?.status === "failed" && reaped_queued?.status === "failed",
);

const untouched = await read_job(actor, fresh_processing.id);
check(
  "a healthy in-flight job is left alone",
  untouched?.status === "processing",
  `status=${untouched?.status}`,
);

const passed = results.filter((r) => r.passed).length;
console.log(`\n${passed}/${results.length} checks passed.`);
process.exit(passed === results.length ? 0 : 1);

/**
 * Realtime smoke test — run against a real Supabase project.
 *
 *   node --env-file=.env.local tests/realtime_smoke.mjs
 *
 * Mirrors the dashboard subscription in components/dashboard_view.tsx and asserts:
 *   - the owner receives INSERT/UPDATE events for their own jobs,
 *   - another user subscribed to the same table receives nothing for them (RLS
 *     is enforced on the socket, not just on REST).
 *
 * Requires "Confirm email" to be OFF. Uses the anon key only.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon_key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anon_key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  process.exit(1);
}

const BUCKET = "job-images";
const SUBSCRIBE_TIMEOUT_MS = 10_000;
const EVENT_TIMEOUT_MS = 10_000;
const SETTLE_MS = 1_000;
const results = [];

function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function make_user(label) {
  const client = createClient(url, anon_key);
  const email = `rt-smoke-${label}-${crypto.randomUUID()}@klylo-smoke.dev`;
  const { data, error } = await client.auth.signUp({ email, password: `pw-${crypto.randomUUID()}` });
  if (error) throw new Error(`sign up ${label}: ${error.message}`);
  if (!data.session) {
    throw new Error(`sign up ${label}: no session — turn "Confirm email" off for this test.`);
  }
  // Realtime authorises the socket with the caller's JWT; RLS depends on it.
  await client.realtime.setAuth(data.session.access_token);
  return { client, user_id: data.user.id };
}

/** Subscribes exactly like the dashboard does, and collects events. */
function watch(actor) {
  const events = [];
  const waiters = [];

  const channel = actor.client
    .channel(`jobs:${actor.user_id}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "jobs", filter: `user_id=eq.${actor.user_id}` },
      (payload) => {
        events.push(payload);
        for (const waiter of waiters.splice(0)) waiter();
      },
    );

  const subscribed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("subscribe timed out")), SUBSCRIBE_TIMEOUT_MS);
    channel.subscribe((status) => {
      switch (status) {
        case "SUBSCRIBED":
          clearTimeout(timer);
          resolve();
          break;
        case "CHANNEL_ERROR":
        case "TIMED_OUT":
        case "CLOSED":
          clearTimeout(timer);
          reject(new Error(`channel status ${status}`));
          break;
      }
    });
  });

  /** Resolves once `predicate` matches a collected event, or null on timeout. */
  async function wait_for(predicate) {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    for (;;) {
      const hit = events.find(predicate);
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, deadline - Date.now());
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  return { channel, subscribed, events, wait_for };
}

const owner = await make_user("owner");
const other = await make_user("other");

const owner_watch = watch(owner);
const other_watch = watch(other);
await Promise.all([owner_watch.subscribed, other_watch.subscribed]);
check("both channels reach SUBSCRIBED", true);

// SUBSCRIBED can fire a beat before the server-side replication filter is live, so an
// INSERT issued immediately after is occasionally missed. The dashboard absorbs this with
// its catch-up refetch on SUBSCRIBED; here we just settle so the assertions are stable.
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const image_path = `${owner.user_id}/${crypto.randomUUID()}.png`;
const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const { error: upload_error } = await owner.client.storage
  .from(BUCKET)
  .upload(image_path, png, { contentType: "image/png" });
if (upload_error) throw new Error(`upload: ${upload_error.message}`);

const { data: job, error: insert_error } = await owner.client
  .from("jobs")
  .insert({ user_id: owner.user_id, prompt: "realtime smoke", image_path })
  .select("*")
  .single();
if (insert_error) throw new Error(`insert: ${insert_error.message}`);

const insert_event = await owner_watch.wait_for(
  (e) => e.eventType === "INSERT" && e.new?.id === job.id,
);
check("owner receives INSERT", Boolean(insert_event), `status=${insert_event?.new?.status}`);

// Walk the worker's state machine and assert each transition arrives live.
for (const patch of [
  { status: "processing" },
  { status: "done", result_url: image_path },
]) {
  const { error } = await owner.client.from("jobs").update(patch).eq("id", job.id);
  if (error) throw new Error(`update ${patch.status}: ${error.message}`);

  const event = await owner_watch.wait_for(
    (e) => e.eventType === "UPDATE" && e.new?.id === job.id && e.new?.status === patch.status,
  );
  check(`owner receives UPDATE -> ${patch.status}`, Boolean(event));
}

// The other user's socket must never have seen this job.
const leaked = other_watch.events.filter((e) => (e.new?.id ?? e.old?.id) === job.id);
check("other user's channel receives nothing", leaked.length === 0, `${leaked.length} leaked event(s)`);

// Cleanup.
await owner.client.from("jobs").delete().eq("id", job.id);
await owner.client.storage.from(BUCKET).remove([image_path]);
await owner.client.removeChannel(owner_watch.channel);
await other.client.removeChannel(other_watch.channel);

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * Cross-user isolation smoke test — run against a real Supabase project.
 *
 *   node --env-file=.env.local tests/rls_smoke.mjs
 *
 * Requires "Confirm email" to be OFF in Authentication → Providers → Email,
 * otherwise the two throwaway sign-ups never get a session.
 * Uses the anon key only; it proves RLS, not admin access.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon_key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anon_key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  process.exit(1);
}

const BUCKET = "job-images";
const results = [];

function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function make_user(label) {
  const client = createClient(url, anon_key);
  const email = `rls-smoke-${label}-${crypto.randomUUID()}@example.com`;
  const password = `pw-${crypto.randomUUID()}`;

  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`sign up ${label}: ${error.message}`);
  if (!data.session) {
    throw new Error(
      `sign up ${label}: no session returned — turn "Confirm email" off for this test.`,
    );
  }
  return { client, user_id: data.user.id, email };
}

async function seed_job(actor, label) {
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
  if (upload_error) throw new Error(`upload ${label}: ${upload_error.message}`);

  const { data, error } = await actor.client
    .from("jobs")
    .insert({ user_id: actor.user_id, prompt: `smoke ${label}`, image_path })
    .select("*")
    .single();
  if (error) throw new Error(`insert ${label}: ${error.message}`);

  return { job: data, image_path };
}

const alice = await make_user("a");
const bob = await make_user("b");

const alice_seed = await seed_job(alice, "alice");
const bob_seed = await seed_job(bob, "bob");

check("owner reads own job", alice_seed.job.status === "queued", `status=${alice_seed.job.status}`);

// 1. Bob must not see Alice's row.
const { data: cross_read } = await bob.client.from("jobs").select("*").eq("id", alice_seed.job.id);
check("cross-user SELECT returns nothing", (cross_read ?? []).length === 0);

// 2. Bob's unfiltered list must contain only his own rows.
const { data: bob_list } = await bob.client.from("jobs").select("id, user_id");
check(
  "unfiltered list is scoped to the caller",
  (bob_list ?? []).every((row) => row.user_id === bob.user_id),
  `${bob_list?.length ?? 0} row(s)`,
);

// 3. Bob must not be able to mutate Alice's row.
const { data: cross_update } = await bob.client
  .from("jobs")
  .update({ status: "done" })
  .eq("id", alice_seed.job.id)
  .select("id");
check("cross-user UPDATE affects no rows", (cross_update ?? []).length === 0);

// 4. Bob must not be able to sign a URL for Alice's object.
const { data: cross_sign, error: sign_error } = await bob.client.storage
  .from(BUCKET)
  .createSignedUrl(alice_seed.image_path, 60);
check("cross-user signed URL is refused", !cross_sign?.signedUrl, sign_error?.message ?? "");

// 5. The owner must still be able to sign their own object.
const { data: own_sign } = await alice.client.storage
  .from(BUCKET)
  .createSignedUrl(alice_seed.image_path, 60);
check("owner can sign own object", Boolean(own_sign?.signedUrl));

// 6. The bucket must not be readable without a signature.
const public_url = `${url}/storage/v1/object/public/${BUCKET}/${alice_seed.image_path}`;
const public_response = await fetch(public_url);
check("bucket is private (public URL rejected)", !public_response.ok, `HTTP ${public_response.status}`);

// Cleanup.
for (const [actor, seed] of [
  [alice, alice_seed],
  [bob, bob_seed],
]) {
  await actor.client.from("jobs").delete().eq("id", seed.job.id);
  await actor.client.storage.from(BUCKET).remove([seed.image_path]);
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);

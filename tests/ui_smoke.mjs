/**
 * UI smoke test — drives the real React components in a real browser.
 *
 *   npm run dev            # in another shell
 *   node --env-file=.env.local tests/ui_smoke.mjs
 *
 * The other suites prove the APIs beneath the UI; this one proves the wiring:
 *   - the unauthenticated root redirects to /login,
 *   - sign-up through AuthForm lands on the dashboard,
 *   - the realtime channel reports "connected",
 *   - JobForm uploads an image and creates a job that renders as a card,
 *   - SignedImage resolves the private object to a URL the browser can load,
 *   - JobForm rejects an empty prompt, a non-image, and an oversized file,
 *   - the card walks queued -> processing -> done|failed with no reload,
 *   - an out-of-band UPDATE arrives over the websocket (deterministic failure),
 *   - Retry is offered on `failed` only, and re-runs the worker,
 *   - timestamps hydrate cleanly and then localise to the viewer's timezone,
 *   - a failing refetch raises the dashboard error banner, whose Retry clears it,
 *   - sign-out drops the session, and signing back in restores the job list,
 *   - a second job is listed above the first, on both the realtime and the reload path.
 *
 * Requires "Confirm email" to be OFF. Uses the anon key only.
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon_key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const base_url = process.env.BASE_URL ?? "http://localhost:3000";
const headed = process.env.HEADED === "1";

if (!url || !anon_key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  process.exit(1);
}

const BUCKET = "job-images";
const TERMINAL_TIMEOUT_MS = 45_000;
const results = [];

function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const png_base64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Status text shown on the single job card, or null while none is rendered. */
async function card_status(page) {
  const badge = page.locator("article span.rounded.px-2").first();
  return (await badge.count()) === 0 ? null : (await badge.innerText()).trim();
}

async function wait_for_terminal(page) {
  const started = Date.now();
  while (Date.now() - started < TERMINAL_TIMEOUT_MS) {
    const status = await card_status(page);
    if (status === "done" || status === "failed") {
      return { status, elapsed_ms: Date.now() - started };
    }
    await page.waitForTimeout(500);
  }
  return { status: await card_status(page), elapsed_ms: Date.now() - started };
}

/** True once the <img> matched by `locator` has actually decoded pixels. */
async function image_loaded(locator) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // The element appears first and decodes a beat later, so poll both.
    const decoded = await locator
      .first()
      .evaluate((node) => node.complete && node.naturalWidth > 0)
      .catch(() => false);
    if (decoded) {
      return true;
    }
    await locator.page().waitForTimeout(250);
  }
  return false;
}

/** The inline validation message JobForm is currently showing, if any. */
async function form_error(page) {
  const alert = page.locator('form [role="alert"]');
  return (await alert.count()) === 0 ? null : (await alert.first().innerText()).trim();
}

const valid_png = {
  name: "reference.png",
  mimeType: "image/png",
  buffer: Buffer.from(png_base64, "base64"),
};

// Fail fast with a clear message if the dev server is not up.
try {
  await fetch(base_url, { method: "HEAD" });
} catch {
  console.error(`Cannot reach ${base_url} — start the dev server first (npm run dev).`);
  process.exit(1);
}

const email = `ui-smoke-${crypto.randomUUID()}@klylo-smoke.dev`;
const password = `pw-${crypto.randomUUID()}`;

const browser = await chromium.launch({ headless: !headed });
// A viewer whose timezone differs from the renderer's is the production case
// (Vercel renders in UTC) and is what makes a `toLocaleString()` in render show
// up as a hydration mismatch. Pin it so the regression cannot come back quietly.
const page = await browser
  .newContext({ timezoneId: "Asia/Tokyo", locale: "ja-JP" })
  .then((context) => context.newPage());
const console_errors = [];
page.on("pageerror", (error) => console_errors.push(error.message));

try {
  // 1. Unauthenticated root lands on the login screen.
  await page.goto(base_url, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/login", { timeout: 15_000 });
  check("root redirects to /login", new URL(page.url()).pathname === "/login", page.url());

  // 2. Sign up through AuthForm.
  await page.getByRole("button", { name: "No account? Sign up" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  check("sign up lands on the dashboard", new URL(page.url()).pathname === "/dashboard", email);

  // 3. The dashboard shows the session and the empty state.
  const email_label = page.getByText(email, { exact: true });
  await email_label.waitFor({ timeout: 15_000 });
  check("dashboard shows the signed-in email", await email_label.isVisible());
  await page.getByText("No jobs yet. Submit one above.").waitFor({ timeout: 10_000 });
  check("empty state is shown for a new user", true);

  // 4. The realtime channel connects.
  await page.getByText("Realtime connected").waitFor({ timeout: 20_000 });
  check("realtime channel reports connected", true);

  // 5. JobForm rejects bad input before anything reaches Storage.
  const file_input = page.locator('input[type="file"]');

  // A blank prompt passes the browser's `required` check but not ours.
  await page.locator("textarea").fill("   ");
  await file_input.setInputFiles(valid_png);
  await page.getByRole("button", { name: "Create job" }).click();
  check("blank prompt is rejected", (await form_error(page)) === "Prompt is required.");

  await file_input.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  check(
    "non-image file is rejected",
    (await form_error(page)) === "Only JPG or PNG images are allowed.",
    (await form_error(page)) ?? "no error shown",
  );

  await file_input.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  check(
    "oversized file is rejected",
    (await form_error(page)) === "Image must be 5 MB or smaller.",
    (await form_error(page)) ?? "no error shown",
  );

  check("no card was created by the rejected submissions", (await page.locator("article").count()) === 0);

  // 6. Submit a valid job through JobForm.
  const prompt = `ui smoke ${crypto.randomUUID()}`;
  await page.locator("textarea").fill(prompt);
  await file_input.setInputFiles(valid_png);
  await page.getByRole("button", { name: "Create job" }).click();

  await page.locator("article").first().waitFor({ timeout: 30_000 });
  const first_status = await card_status(page);
  check(
    "submitting renders a card in a pre-terminal status",
    ["queued", "processing…"].includes(first_status ?? ""),
    `status=${first_status}`,
  );
  check("card shows the submitted prompt", await page.getByText(prompt).first().isVisible());

  // 7. SignedImage turned the private object into a URL the browser could fetch.
  check(
    "reference image loads through a signed URL",
    await image_loaded(page.locator('article img[alt="Reference image"]')),
  );

  // 8. The worker drives the card to a terminal status without a reload.
  const terminal = await wait_for_terminal(page);
  check(
    "card reaches a terminal status live",
    ["done", "failed"].includes(terminal.status ?? ""),
    `status=${terminal.status} after ${(terminal.elapsed_ms / 1000).toFixed(1)}s`,
  );

  if (terminal.status === "done") {
    check(
      "result image loads through a signed URL",
      await image_loaded(page.locator('article img[alt="Job result"]')),
    );
    // The brief asks for a URL, and the private bucket means one only exists once
    // signed — so the card exposes the signed URL itself, not just the rendered image.
    const result_link = page.getByRole("link", { name: /^Open signed result URL/ }).first();
    await result_link.waitFor({ timeout: 15_000 });
    const href = await result_link.getAttribute("href");
    check(
      "result is reachable as a signed URL",
      typeof href === "string" && href.includes("/job-images/") && href.includes("token="),
      href ? `${href.split("?")[0]} …?token=…` : "no href",
    );
  } else {
    check("result image loads through a signed URL", true, "skipped — job failed this run");
    check("result is reachable as a signed URL", true, "skipped — job failed this run");
  }

  // The reference thumbnail is captioned so it cannot be mistaken for the result.
  check(
    "reference and result are labelled distinctly",
    (await page.locator("article").first().getByText("Reference", { exact: true }).count()) === 1,
  );

  // 9. Force a failure out of band. The page must learn about it over the
  //    websocket, which also makes the Retry path deterministic.
  const client = createClient(url, anon_key);
  const { data: signed_in, error: sign_in_error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (sign_in_error) throw new Error(`sign in: ${sign_in_error.message}`);

  const { data: rows } = await client.from("jobs").select("*").eq("user_id", signed_in.user.id);
  const job = rows?.[0];
  if (!job) throw new Error("the job created through the UI is not visible to its owner");

  await client
    .from("jobs")
    .update({ status: "failed", error_message: "forced by ui smoke", result_url: null })
    .eq("id", job.id);

  await page.getByText("forced by ui smoke").waitFor({ timeout: 20_000 });
  check("out-of-band update arrives over realtime", (await card_status(page)) === "failed");

  const retry = page.getByRole("button", { name: "Retry" });
  check("retry is offered on a failed job", await retry.isEnabled());

  // 10. Retry re-runs the worker and the card settles again.
  await retry.click();
  // Guard against reading the pre-click "failed" badge back as the new result.
  await page.waitForFunction(
    () => !document.querySelector("article span.rounded.px-2")?.textContent?.includes("failed"),
    undefined,
    { timeout: 15_000 },
  );
  const retried = await wait_for_terminal(page);
  check(
    "retry drives the card to a terminal status again",
    ["done", "failed"].includes(retried.status ?? ""),
    `status=${retried.status} after ${(retried.elapsed_ms / 1000).toFixed(1)}s`,
  );

  // 11. A failing refetch must surface the dashboard error banner, and its own
  //     Retry must clear it once the request succeeds again.
  await page.route("**/rest/v1/jobs*", (route) => route.abort("failed"));
  const banner = page.locator('section > div[role="alert"]');
  await page.reload({ waitUntil: "domcontentloaded" });
  await banner.waitFor({ timeout: 20_000 });
  check("a failing refetch raises the error banner", await banner.isVisible());

  await page.unroute("**/rest/v1/jobs*");
  await banner.getByRole("button", { name: "Retry" }).click();
  await banner.waitFor({ state: "hidden", timeout: 20_000 });
  check("the banner's Retry clears the error", (await banner.count()) === 0);

  // 12. The reload above re-rendered an existing card on the server, which is
  //     when a timestamp formatted during render would mismatch on hydration.
  const stamp = page.locator("article time").first();
  const stamp_text = (await stamp.innerText()).trim();
  check(
    "timestamp localises to the viewer's timezone",
    !stamp_text.endsWith("UTC") && stamp_text.length > 0,
    stamp_text,
  );

  // 13. Sign out drops the session and the dashboard becomes unreachable.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login", { timeout: 20_000 });
  await page.goto(`${base_url}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/login", { timeout: 15_000 });
  check("signed-out /dashboard redirects to /login", new URL(page.url()).pathname === "/login");

  // 14. Signing back in as an existing user restores the job list.
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  const persisted = page.getByText(prompt).first();
  await persisted.waitFor({ timeout: 15_000 });
  check("existing user can sign in and sees the persisted job", await persisted.isVisible());

  // 15. A second job must land at the top: the dashboard is ordered newest-first, both
  //     from the server query and from the client-side merge that realtime feeds.
  const second_prompt = `ui smoke newer ${crypto.randomUUID()}`;
  await page.locator("textarea").fill(second_prompt);
  await page.locator('input[type="file"]').setInputFiles(valid_png);
  await page.getByRole("button", { name: "Create job" }).click();

  await page.locator("article").nth(1).waitFor({ timeout: 30_000 });
  check("both jobs are listed", (await page.locator("article").count()) === 2);

  const order = await page.locator("article").allInnerTexts();
  check(
    "newest job is listed first",
    order[0].includes(second_prompt) && order[1].includes(prompt),
    order[0].includes(second_prompt) ? "newer card is at index 0" : "wrong order",
  );

  // Ordering must survive a reload too — that path is the server query, not the merge.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("article").nth(1).waitFor({ timeout: 30_000 });
  const reloaded = await page.locator("article").allInnerTexts();
  check(
    "newest-first order survives a reload",
    reloaded[0].includes(second_prompt) && reloaded[1].includes(prompt),
  );

  // 16. Regression: a tab that restored its session from cookies rather than signing in
  //     on the page must still receive realtime. The socket has to carry the JWT before
  //     it joins — an anonymous join is accepted, reports SUBSCRIBED, and then silently
  //     delivers nothing, which left every cold-loaded tab frozen on its initial render.
  const cold = await page.context().newPage();
  const cold_frames = [];
  cold.on("websocket", (ws) =>
    ws.on("framesent", (frame) => {
      const body = String(frame.payload ?? "");
      if (body.includes("phx_join")) {
        cold_frames.push(/"access_token":"ey/.test(body));
      }
    }),
  );
  await cold.goto(`${base_url}/dashboard`, { waitUntil: "domcontentloaded" });
  await cold.getByText("Realtime connected").waitFor({ timeout: 20_000 });
  await cold.locator("article").first().waitFor({ timeout: 20_000 });
  check(
    "cold-loaded tab joins realtime with a JWT",
    cold_frames.length > 0 && cold_frames.every(Boolean),
    `${cold_frames.filter(Boolean).length}/${cold_frames.length} joins authenticated`,
  );

  const probe = `cold reload ${crypto.randomUUID()}`;
  await client.from("jobs").update({ prompt: probe }).eq("id", job.id);
  let cold_saw_it = false;
  for (let attempt = 0; attempt < 20 && !cold_saw_it; attempt += 1) {
    cold_saw_it = (await cold.getByText(probe).count()) > 0;
    if (!cold_saw_it) {
      await cold.waitForTimeout(500);
    }
  }
  check("cold-loaded tab receives realtime updates", cold_saw_it);
  await cold.close();

  check(
    "no uncaught errors in the page",
    console_errors.length === 0,
    console_errors.join(" | ") || "none",
  );

  // Cleanup: the row and its uploaded object, under the owner's own RLS.
  await client.from("jobs").delete().eq("id", job.id);
  await client.storage.from(BUCKET).remove([job.image_path]);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);

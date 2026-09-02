# Klylo — Video Job Queue

A small Next.js 16 (App Router) + Supabase app: sign in, submit a simulated video job
(prompt + reference image), and watch the status change live via Supabase Realtime.

**Live demo:** https://klylo-video-queue.vercel.app — sign up with any email and password
(email confirmation is off), then submit a job.

- **Auth** — Supabase email/password; `/dashboard` is only reachable when signed in.
- **Jobs** — prompt + one JPG/PNG (≤ 5 MB) uploaded to a **private** Storage bucket.
- **Worker** — Route Handler that flips the job to `processing`, sleeps 5–15 s, then
  finishes `done` (80 %) or `failed` (20 %).
- **Realtime** — the dashboard updates without a refresh.
- **Retry** — available on `failed` jobs only.

## Setup

### 1. Supabase project

Create a project at [supabase.com](https://supabase.com), then open **SQL Editor** and run
the two files in [`supabase/migrations/`](supabase/migrations/) in filename order. Both are
idempotent. The first creates everything the app needs:

- `job_status` enum and the `jobs` table (+ `updated_at` trigger, index on `(user_id, created_at desc)`)
- RLS enabled with select/insert/update/delete policies scoped to `auth.uid()`
- `jobs` added to the `supabase_realtime` publication
- the **private** `job-images` bucket (5 MB limit, `image/jpeg` + `image/png` only) and
  its `storage.objects` policies (`<user_id>/…` prefix ownership)

The second adds the stale-job reaper: `reap_stale_jobs()` plus a `pg_cron` entry that runs it
every minute. If `pg_cron` is unavailable on your plan the migration still succeeds — it
raises a notice and leaves the function unscheduled, and the app works exactly as before,
minus the recovery.

Under **Authentication → Providers → Email**, turn *Confirm email* off if you want to sign
in immediately after signing up (the UI handles both cases).

### 2. Environment

```bash
cp .env.example .env.local
```

| Variable | Where to find it |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API → anon / publishable key |

There is **no** `service_role` key in this project — client *or* server.

### 3. Run

```bash
npm install
npm run dev     # http://localhost:3000
```

`npm run build` type-checks and builds; `npm run lint` lints. Both run on every push and
pull request via `.github/workflows/ci.yml` — the build needs no secrets, since every page
is dynamic and nothing is rendered against a real project at build time.

### 4. Deploy (optional)

Import the repo on Vercel and set the same two env vars. The worker route declares
`maxDuration = 60` so its 5–15 s sleep is not cut off.

## Security

The three hard requirements, and where each is enforced. Every rule lives in Postgres, so
removing the UI or replaying its requests by hand gains nothing — client-side checks are UX,
the policies are the enforcement.

| Requirement | Enforced by | Proof |
| --- | --- | --- |
| RLS on `jobs`, own rows only | Four policies granted to `authenticated`, all on `auth.uid() = user_id` | `test:rls` 1–4 |
| Private bucket, signed URLs | `storage.buckets.public = false`; `storage.objects` policies on the `<user_id>/…` prefix | `test:rls` 5–7 |
| No `service_role` on the client | The key does not exist in this project at all | `lib/supabase/env.ts` reads only the two `NEXT_PUBLIC_*` vars |

- **`update` carries both `using` and `with check`.** `using` picks the rows you may target;
  `with check` validates the row *after* the write. Without the second, you could take a job
  you own and reassign its `user_id` to someone else.
- **`user_id` defaults to `auth.uid()`,** so the client is never trusted to supply it — and
  `with check` makes a forged value fail rather than land.
- **Realtime re-evaluates RLS per subscriber,** which is why the socket must carry a JWT; an
  anonymous one subscribes successfully and then receives nothing. See the realtime bullet
  under Key decisions.
- **The bucket enforces the 5 MB cap and the JPG/PNG allowlist,** not just `JobForm`, so a
  hand-rolled upload hits the same limits.
- **The worker route uses the caller's session** and 401s without one, so the one place a
  privileged key is normally reached for does not have one.
- **There is no `getPublicUrl` call anywhere in the repo** — every image is a fresh
  10-minute signed URL.

## Tests

`tests/rls_smoke.mjs` is a standalone RLS smoke test. It signs up two throwaway users with
the **anon key only** (no `service_role` anywhere) and asserts seven things:

1. user A reads back its own job,
2. user B's `select` on user A's job id returns nothing,
3. an unfiltered `select * from jobs` is silently scoped to the caller,
4. user B's `update` on user A's job affects 0 rows,
5. user B cannot sign a URL for user A's storage object,
6. user A *can* sign its own object,
7. the bucket's public URL does not serve the object.

```bash
npm run test:rls
```

`tests/realtime_smoke.mjs` subscribes exactly the way `components/dashboard_view.tsx` does
and asserts that the owner receives the `INSERT` and both `UPDATE`s
(`queued -> processing -> done`) live, while a second user subscribed to the same table
receives nothing for that job — i.e. RLS is enforced on the websocket, not only on REST.

```bash
npm run test:realtime
```

`tests/worker_smoke.mjs` drives the route handler over real HTTP against a running dev
server, rebuilding the session cookie `@supabase/ssr` would have written. It asserts that an
unauthenticated call is rejected (401), another user's job is invisible (404, via RLS), a
queued job reaches `done` or `failed` after a 5-15 s sleep with a consistent row, a
`processing` job cannot be retried (409), and two concurrent calls claim the job exactly
once (200 / 409).

```bash
npm run dev            # in another shell
npm run test:worker
```

`tests/reaper_smoke.mjs` covers the stale-job reaper. It backdates a `processing` and a
`queued` job by five minutes, checks the reaper cannot be called from a client role at all
(it is `security definer`, so a caller would see every user's rows), then waits for cron and
asserts both rows land on `failed` with the right explanation while a healthy in-flight job
is left alone. Cron fires once a minute, so this one takes up to ~2 minutes.

```bash
npm run test:reaper
```

`tests/ui_smoke.mjs` drives the actual React components in headless Chromium (Playwright,
no test runner — the same plain-node style as the others). It signs up through `AuthForm`,
checks that `JobForm` rejects a blank prompt, a non-image and a >5 MB file without creating
anything, then submits a valid job and asserts that the card appears `queued`, that
`SignedImage` resolves the private object to a URL the browser really decodes, and that the
status reaches `done`/`failed` with no reload. It flips the row to `failed` out of band so
the websocket path and the `failed`-only Retry button are covered deterministically rather
than waiting on the worker's 20 % branch, aborts the jobs REST call to raise the dashboard
error banner and clears it with the banner's own Retry, checks the `done` card exposes an
**Open signed result URL** link and captions the two images distinctly, and finally signs
out, confirms `/dashboard` is unreachable, and signs back in to check the job persisted —
then that the list is newest-first both after a realtime merge and after a reload, and that
a cold-loaded tab joins realtime with a JWT and receives updates. Any uncaught page error
fails the run.

The browser context is pinned to `Asia/Tokyo` / `ja-JP` on purpose: a viewer whose timezone
differs from the renderer's is the production case (Vercel renders in UTC), and it is the
only condition under which a date formatted during render shows up as a hydration mismatch.
That is a real bug this suite caught — see `components/local_time.tsx`.

```bash
npx playwright install chromium   # once
npm run dev                       # in another shell
npm run test:ui                   # HEADED=1 to watch it
```

All five require **Authentication -> Providers -> Email -> Confirm email = OFF**, otherwise
the throwaway test users never get a session. Every suite honours `BASE_URL`, so the worker
and UI suites can be pointed at the deployment
(`BASE_URL=https://klylo-video-queue.vercel.app npm run test:ui`); both pass there.

A green run is `test:rls` 7/7, `test:realtime` 5/5, `test:worker` 7/7 and `test:ui` 30/30.

## Key decisions

- **Upload + insert happen in the browser, under RLS.** The anon key plus the user's JWT
  is enough, so no privileged key ever exists server-side, and the 4.5 MB serverless
  request-body limit never applies to the 5 MB image.
- **The worker is a Route Handler that uses the caller's session** (`app/api/jobs/[id]/process/route.ts`).
  It claims the job with a conditional update (`.in("status", ["queued", "failed"])`) so two
  concurrent requests can't both start it, and it refuses jobs that are already `processing`
  — that is what makes Retry safe on the server, not just a disabled button.
- **`result_url` stores the Storage object path, not a URL.** The brief asks for "the URL of
  the uploaded image" *and* for a private bucket, and those two pull against each other: the
  only URL that can reach a private object is a signed one, and it expires. Persisting it
  would leave the column pointing at a dead link within the hour. So the column holds the
  stable object path and the UI mints a fresh 10-minute signed URL on render
  (`lib/use_signed_url.ts`). To keep the requirement visible rather than implied, a `done`
  card renders both the result image and an **Open signed result URL** link to that URL, so
  you can click through to the object itself.
- **A signed URL is a bearer credential, and the UI says so.** Anyone holding the URL can
  fetch that object without a session — that is what a signed URL *is*, not a gap in RLS.
  RLS governs who may **mint** one (`job_images_select_own`: only the owner can sign their
  own path); the token itself is then a capability with a 10-minute fuse, scoped to a single
  object. The link is labelled with its expiry so that is visible rather than implied. Three
  properties keep it defensible: short TTL, never persisted to the database, and never
  logged in full (the UI suite truncates it to `…?token=…`). Removing bearer exposure
  entirely would mean proxying bytes through a session-checked route handler, which the
  brief rules out by asking for signed URLs — and would put every image byte through
  serverless bandwidth.
- **The reference and result images are captioned.** They are deliberately the same picture —
  the brief defines the simulated result as the uploaded image — so without the "Reference"
  and "Result" labels a card looks like it just drew the same thing twice.
- **`app/dashboard/loading.tsx`** is the Suspense fallback for the dynamic dashboard. The
  in-page loading affordances (`Submitting…`, `Connecting…`, the `processing` progress bar,
  image skeletons) cover everything after first paint; this covers the fetch before it.
- **A stranded job is failed, not resurrected.** The worker runs in the browser, so a job
  can strand two ways: `processing` if the tab closes mid-run, or `queued` if the POST to
  the worker never lands. `reap_stale_jobs()` runs every minute under `pg_cron` and fails
  anything in either status whose `updated_at` is older than 90 s — comfortably past the
  worst legitimate run, since the route declares `maxDuration = 60` and sleeps at most 15 s.
  Failing them is deliberate rather than a shortcut: `failed` is exactly the status
  `JobCard` offers Retry on, so recovery reuses the path that already exists instead of
  adding a second one. The function is `security definer` (cron has no user session) and
  therefore revoked from `anon` and `authenticated` — otherwise one user could fail
  another's in-flight job.
- **The `updated_at` trigger respects an explicit value.** It stamps `now()` only when the
  update leaves the column alone, which is what makes "pretend this row is old" expressible
  and the reaper testable in seconds rather than minutes. Under RLS a user can only do that
  to their own rows.
- **Realtime plus a catch-up refetch.** On `SUBSCRIBED` the dashboard refetches once, so
  changes that happened between the server render and the socket opening aren't missed.
- **The realtime socket is authenticated before it joins.** Realtime enforces RLS on the
  replication stream, and an *anonymous* join is accepted: the channel reports `SUBSCRIBED`,
  paints "Realtime connected", and then delivers nothing at all. A tab that restored its
  session from cookies — a plain reload, or a second tab — used to join that way and sit
  frozen on its server-rendered snapshot until the user refreshed. `dashboard_view.tsx`
  therefore resolves the session, calls `realtime.setAuth()` before subscribing, and keeps
  the socket in step with token refreshes and sign-outs via `onAuthStateChange`. The UI
  suite pins this down with two checks: the `phx_join` frame must carry a JWT, and a
  cold-loaded tab must receive an update. Both fail against the previous code.
- **`proxy.ts` (Next 16's renamed `middleware.ts`)** refreshes the session cookie and does a
  cheap redirect, but every page/route re-checks `auth.getUser()` — the proxy is not the
  security boundary; RLS is.
- **Timestamps render as UTC first, then localise** (`components/local_time.tsx`). Calling
  `toLocaleString()` during render resolves against the *renderer's* timezone — UTC on
  Vercel, the viewer's own in the browser — so the two passes disagree and React reports a
  hydration mismatch (#418). `useSyncExternalStore` gives SSR and hydration one fixed UTC
  string and swaps in the viewer's locale afterwards.
- **snake_case** for functions/variables per the repo conventions; components stay PascalCase.

## Known gaps / next steps

- **The reaper fails a stranded job rather than resuming it.** Recovery is a Retry button,
  not a transparent re-dispatch, and detection takes up to ~2.5 min (90 s of staleness plus
  the one-minute cron tick). A real queue — Vercel Queues, or `pg_cron` driving a Supabase
  Edge Function — would own the run and resume it instead.
- **The uploaded MIME type is client-asserted.** `JobForm` sends `contentType: file.type`
  and the bucket's `allowed_mime_types` validates that *declared* header, not the bytes, so
  arbitrary content can be stored under an `image/png` label. Low severity — objects are
  served from the Storage origin with the stored content type, so nothing executes in the
  app's origin — but it is storage abuse a magic-byte check (or an Edge Function that
  re-encodes on upload) would close.
- **No per-user quota or rate limit.** RLS scopes *whose* rows you touch, not *how many*: a
  signed-in user can create unlimited jobs and 5 MB objects. A `count(*)` check in an
  insert policy, or a trigger enforcing a ceiling, is the cheap version.
- **CI runs lint and build only.** The four suites need a live Supabase project with
  *Confirm email* off and create real users, so they are deliberately manual; a green check
  on a PR therefore proves it compiles, not that it works. Pointing them at a dedicated
  throwaway project from CI is the fix.
- **No security headers.** `next.config.ts` sets no CSP, `X-Frame-Options`, or
  `Referrer-Policy`. Nothing here renders user-supplied HTML, so this is hardening rather
  than an open hole.
- **The UI suite is one browser, one viewport, one path per feature.** It runs only
  headless Chromium at the default desktop size; there is no cross-browser or mobile run,
  and each behaviour is asserted once rather than as a matrix.
- **`SUBSCRIBED` can fire just before the replication filter is live**, so a row inserted in
  that same instant is not delivered over the socket. The dashboard's catch-up refetch
  covers it in practice; a stricter fix would be to not trust `SUBSCRIBED` as the readiness
  signal at all.
- **Signed URLs are re-minted per card on every mount** — fine at this scale, but a shared
  cache keyed by path with expiry would cut requests.
- **No pagination** on the job list, and no delete-job action (rows and objects accumulate).
- **Password reset / email verification flows** are intentionally out of scope, as is
  responsive polish below desktop widths.

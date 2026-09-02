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
[`supabase/migrations/20260902120000_init.sql`](supabase/migrations/20260902120000_init.sql) once. It is
idempotent and creates everything the app needs:

- `job_status` enum and the `jobs` table (+ `updated_at` trigger, index on `(user_id, created_at desc)`)
- RLS enabled with select/insert/update/delete policies scoped to `auth.uid()`
- `jobs` added to the `supabase_realtime` publication
- the **private** `job-images` bucket (5 MB limit, `image/jpeg` + `image/png` only) and
  its `storage.objects` policies (`<user_id>/…` prefix ownership)

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

## Tests

`tests/rls_smoke.mjs` is a standalone RLS smoke test. It signs up two throwaway users with
the **anon key only** (no `service_role` anywhere) and asserts six things:

1. user B's `select` on user A's job id returns nothing,
2. an unfiltered `select * from jobs` is silently scoped to the caller,
3. user B's `update` on user A's job affects 0 rows,
4. user B cannot sign a URL for user A's storage object,
5. user A *can* sign its own object,
6. the bucket's public URL does not serve the object.

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

`tests/ui_smoke.mjs` drives the actual React components in headless Chromium (Playwright,
no test runner — the same plain-node style as the others). It signs up through `AuthForm`,
checks that `JobForm` rejects a blank prompt, a non-image and a >5 MB file without creating
anything, then submits a valid job and asserts that the card appears `queued`, that
`SignedImage` resolves the private object to a URL the browser really decodes, and that the
status reaches `done`/`failed` with no reload. It flips the row to `failed` out of band so
the websocket path and the `failed`-only Retry button are covered deterministically rather
than waiting on the worker's 20 % branch, aborts the jobs REST call to raise the dashboard
error banner and clears it with the banner's own Retry, and finally signs out, confirms
`/dashboard` is unreachable, and signs back in to check the job persisted. Any uncaught page
error fails the run.

The browser context is pinned to `Asia/Tokyo` / `ja-JP` on purpose: a viewer whose timezone
differs from the renderer's is the production case (Vercel renders in UTC), and it is the
only condition under which a date formatted during render shows up as a hydration mismatch.
That is a real bug this suite caught — see `components/local_time.tsx`.

```bash
npx playwright install chromium   # once
npm run dev                       # in another shell
npm run test:ui                   # HEADED=1 to watch it
```

All four require **Authentication -> Providers -> Email -> Confirm email = OFF**, otherwise
the throwaway test users never get a session. Every suite honours `BASE_URL`, so the worker
and UI suites can be pointed at the deployment
(`BASE_URL=https://klylo-video-queue.vercel.app npm run test:ui`); both pass there.

## Key decisions

- **Upload + insert happen in the browser, under RLS.** The anon key plus the user's JWT
  is enough, so no privileged key ever exists server-side, and the 4.5 MB serverless
  request-body limit never applies to the 5 MB image.
- **The worker is a Route Handler that uses the caller's session** (`app/api/jobs/[id]/process/route.ts`).
  It claims the job with a conditional update (`.in("status", ["queued", "failed"])`) so two
  concurrent requests can't both start it, and it refuses jobs that are already `processing`
  — that is what makes Retry safe on the server, not just a disabled button.
- **`result_url` stores the Storage object path, not a URL.** The bucket is private, so any
  URL persisted in the DB would be a signed URL that expires. The UI mints a fresh 10-minute
  signed URL when it renders (`components/signed_image.tsx`).
- **Realtime plus a catch-up refetch.** On `SUBSCRIBED` the dashboard refetches once, so
  changes that happened between the server render and the socket opening aren't missed.
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

- **A browser-driven worker is not durable.** If the tab closes mid-run, the job stays
  `processing` forever. A real fix is a queue (`pg_cron` + a Supabase Edge Function, or
  Vercel Queues) plus a reaper that fails jobs whose `updated_at` is older than ~60 s.
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

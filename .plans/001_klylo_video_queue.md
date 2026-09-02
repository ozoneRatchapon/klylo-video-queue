# 001 — Klylo take-home: video job queue

## Goal
Next.js 16 (App Router, TS) + Supabase (Auth, Postgres, Storage, Realtime) app where a
logged-in user submits a simulated video job (prompt + reference image) and watches its
status change live.

## Steps
1. [x] Scaffold Next.js + TS + Tailwind, install `@supabase/supabase-js` + `@supabase/ssr`.
2. [x] SQL migration: `job_status` enum, `jobs` table, RLS policies, `updated_at` trigger,
       private `job-images` bucket + storage policies, realtime publication.
3. [x] Supabase clients: browser, server (async cookies), `proxy.ts` for session refresh.
4. [x] Auth: `/login` (sign in / sign up), sign-out route, guard on `/dashboard`.
5. [x] Job creation: client-side upload to Storage (`<uid>/<uuid>.ext`) + insert row `queued`,
       then fire the worker.
6. [x] Worker: `POST /api/jobs/[id]/process` — guarded transition to `processing`,
       sleep 5–15 s, 80% `done` (result_url = image path) / 20% `failed` (error_message).
7. [x] Dashboard: server-rendered initial list + realtime `postgres_changes` subscription,
       signed URLs for images, loading/error states, Retry on `failed` only.
8. [x] README (setup, decisions, known gaps) + `.env.example`.
9. [x] `npm run build` + lint clean.

## Key decisions
- Upload + insert happen client-side under RLS → no `service_role` anywhere, no 4.5 MB
  serverless body limit.
- Worker runs as a Route Handler using the caller's session (RLS-scoped), guarded by a
  conditional status update so a job cannot be processed twice.
- `result_url` stores the Storage object path; the UI mints short-lived signed URLs
  (bucket is private, so a stored URL would expire anyway).

## Verification & delivery

Live Supabase project `klylo-video-queue` (ref `cqpobbtiqvtvrtegpnuv`, ap-southeast-1),
deployed at https://klylo-video-queue.vercel.app.

- [x] Project provisioned by the owner; `supabase link` + `supabase db push` applied
      `supabase/migrations/20260902120000_init.sql` to the remote database
- [x] Real `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local`
      (gitignored, never committed; no `service_role` key anywhere)
- [x] Authentication -> Providers -> Email -> **Confirm email = OFF**
- [x] `npm run test:rls` — 7/7
- [x] `npm run test:realtime` — 5/5
- [x] `npm run test:worker` — 7/7 locally and against the deployment; both the `done` and
      the `failed` branch observed
- [x] `npm run test:ui` — 30/30 against a local production build (browser pinned to
      `Asia/Tokyo`/`ja-JP` so it runs in a timezone that differs from the renderer's):
      sign-up, form validation, job submission with a real upload, signed images decoding in
      the browser, live status, out-of-band realtime update, Retry, the dashboard error
      banner, timestamp hydration, the signed result URL, sign-out, sign-back-in, newest-first ordering and
      realtime in a cold-loaded tab.
      Also 30/30 against the deployment (`BASE_URL=https://klylo-video-queue.vercel.app`),
      re-run on `c278c10` so the two realtime-JWT checks are confirmed live, not assumed.
- [x] Fixed a hydration mismatch (React #418) the UI suite surfaced in production only:
      `toLocaleString()` during render disagreed between Vercel's UTC and the viewer's
      timezone. Now `components/local_time.tsx` via `useSyncExternalStore`. Verified against
      both a local production build and the deployment — the suite's "no uncaught errors in
      the page" check is what surfaced #418 in the first place, and it now passes live.
- [x] CI: `.github/workflows/ci.yml` runs lint + build on push and pull request
- [x] Public GitHub repo + Vercel deploy with the two `NEXT_PUBLIC_*` env vars (the Supabase
      Vercel integration is deliberately *not* used — it injects a `service_role` key)

## Post-submission hardening (`develop`)

`main` stays frozen at `5210328`, exactly what the reviewer sees. Hardening lands on
`develop` only.

- [x] **Stale-job reaper** (`supabase/migrations/20260902170000_stale_job_reaper.sql`,
      commit `7781e4f`). A `queued` or `processing` row older than 90s is failed by
      `reap_stale_jobs()`, run every minute by `pg_cron`, with a distinct message per
      branch. It *fails* rather than resumes, because `failed` is the status `JobCard`
      already offers Retry on — recovery reuses the existing path. The function is
      `security definer` and `revoke`d from `anon`/`authenticated`, so one user cannot fail
      another's in-flight job. SQL only; no UI change.
      - `set_updated_at` now stamps `now()` only when the update leaves the column alone,
        which is what makes backdating (and therefore testing) expressible.
      - The `pg_cron` scheduling is wrapped in an exception handler so the migration still
        applies where the extension is unavailable.
      - Applied to the remote database; `cron.job` shows `reap-stale-jobs, * * * * *,
        active: true` and `execute` is granted only to `postgres`/`service_role`.
- [x] `npm run test:reaper` — 8/8 against the remote database, and 2/8 before the migration,
      so the suite is not vacuous. A client calling `reap_stale_jobs()` must get
      `permission denied`; the suite rejects a "could not find the function" error, so
      dropping the function cannot fake a pass. Regression: `test:rls` still 7/7 and
      `test:realtime` still 5/5 after the `set_updated_at` change.

## Remaining (owner-gated)

- [ ] **Owner runs:** finish purging the take-home brief from GitHub. The `filter-branch`
      + force-push is done: the brief is gone from every commit reachable from `main` and
      `origin/main`, and the local clone is fully purged (`refs/original/*` deleted,
      reflog expired, `git gc --prune=now`). What remains is GitHub's own unreachable-object
      cache — `GET /repos/:owner/:repo/contents/klylo-dev-assignment.md?ref=f2e6f58` still
      serves the file. Only the owner can clear it: delete and recreate the repository
      (guaranteed, ~2 min to relink Vercel), or open a GitHub Support ticket asking them to
      garbage-collect. The `gh` token here has scopes `gist, read:org, repo, workflow` —
      no `delete_repo` — so this cannot be automated from the agent.
- [x] Vercel stalled for ~35 min after the 07:45 push (four commits, no deployment record,
      commit status `pending` with zero statuses) while GitHub Actions fired normally on the
      same webhooks — so the lag was Vercel-side, not a broken link. It cleared on its own:
      `a54fc2d` deployed at 08:11Z and the backlog resolved with it. No action needed.
- [ ] Turn *Confirm email* back ON once the reviewer is finished.

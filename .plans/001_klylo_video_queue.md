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
- [x] `npm run test:ui` — 15/15 locally and against the deployment: sign-up, job submission
      with a real upload, signed images decoding in the browser, live status, out-of-band
      realtime update, Retry, sign-out
- [x] Public GitHub repo + Vercel deploy with the two `NEXT_PUBLIC_*` env vars (the Supabase
      Vercel integration is deliberately *not* used — it injects a `service_role` key)

## Remaining (owner-gated)

- [ ] **Owner runs:** purge the take-home brief from git history. It is untracked and
      gitignored at the tip but still visible in commit `f2e6f58`. A history rewrite is
      blocked in auto mode, so:
      `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --index-filter 'git rm --cached --ignore-unmatch klylo-dev-assignment.md' --prune-empty -- --all`
      then `git push --force origin main`. Force-push (not delete-and-recreate) keeps the
      Vercel <-> GitHub link intact; Vercel redeploys automatically.
- [ ] Turn *Confirm email* back ON once the reviewer is finished.

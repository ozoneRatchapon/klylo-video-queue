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

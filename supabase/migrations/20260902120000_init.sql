-- Klylo video queue — initial schema.
-- Idempotent: safe to run more than once in the Supabase SQL editor (as the `postgres` role).

-- 1. Status enum -------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type public.job_status as enum ('queued', 'processing', 'done', 'failed');
  end if;
end
$$;

-- 2. Table -------------------------------------------------------------------
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  prompt        text not null check (char_length(prompt) between 1 and 2000),
  image_path    text not null,
  status        public.job_status not null default 'queued',
  result_url    text,
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists jobs_user_id_created_at_idx
  on public.jobs (user_id, created_at desc);

-- 3. updated_at trigger ------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- 4. Row Level Security ------------------------------------------------------
alter table public.jobs enable row level security;

drop policy if exists "jobs_select_own" on public.jobs;
create policy "jobs_select_own" on public.jobs
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "jobs_insert_own" on public.jobs;
create policy "jobs_insert_own" on public.jobs
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "jobs_update_own" on public.jobs;
create policy "jobs_update_own" on public.jobs
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "jobs_delete_own" on public.jobs;
create policy "jobs_delete_own" on public.jobs
  for delete to authenticated
  using (auth.uid() = user_id);

-- 5. Realtime ----------------------------------------------------------------
-- Realtime still applies RLS per subscriber, so users only receive their own rows.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;
end
$$;

-- 6. Private storage bucket --------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-images', 'job-images', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png'];

-- Objects live at `<user_id>/<uuid>.<ext>`; the first path segment is the owner.
drop policy if exists "job_images_select_own" on storage.objects;
create policy "job_images_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'job-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "job_images_insert_own" on storage.objects;
create policy "job_images_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'job-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "job_images_update_own" on storage.objects;
create policy "job_images_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'job-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "job_images_delete_own" on storage.objects;
create policy "job_images_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'job-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

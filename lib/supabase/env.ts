/** Reads the public Supabase config. Never expose a `service_role` key here. */
export function supabase_env(): { url: string; anon_key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon_key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !anon_key) {
    throw new Error(
      "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example).",
    );
  }

  return { url, anon_key };
}

"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabase_env } from "./env";

const { url, anon_key } = supabase_env();

let client: ReturnType<typeof createBrowserClient> | null = null;

/** Singleton browser client — one instance keeps a single realtime socket open. */
export function supabase_browser() {
  if (!client) {
    client = createBrowserClient(url, anon_key);
  }
  return client;
}

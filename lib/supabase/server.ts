import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabase_env } from "./env";

/** Server client bound to the request cookies (Server Components, Route Handlers). */
export async function supabase_server() {
  const cookie_store = await cookies();
  const { url, anon_key } = supabase_env();

  return createServerClient(url, anon_key, {
    cookies: {
      getAll() {
        return cookie_store.getAll();
      },
      setAll(cookies_to_set) {
        try {
          for (const { name, value, options } of cookies_to_set) {
            cookie_store.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: cookies are read-only there and the
          // session refresh already happened in `proxy.ts`, so this is safe to ignore.
        }
      },
    },
  });
}

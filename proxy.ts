import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabase_env } from "@/lib/supabase/env";

/**
 * Builds the per-request Content-Security-Policy around a fresh nonce.
 *
 * Next.js reads the nonce back out of the `Content-Security-Policy` *request*
 * header and stamps it onto every script and style it emits, so nothing here
 * needs `'unsafe-inline'` for scripts. That only works on dynamically rendered
 * pages — every page in this app awaits `supabase_server()`, so all of them are.
 *
 * The headers that do not vary per request live in `next.config.ts`.
 */
function content_security_policy(nonce: string, supabase_url: string): string {
  const supabase_origin = new URL(supabase_url).origin;
  // Realtime uses the same host over a WebSocket.
  const supabase_socket = supabase_origin.replace(/^https:/, "wss:");
  const is_dev = process.env.NODE_ENV === "development";

  return [
    "default-src 'self'",
    // React uses `eval` in development to rebuild server stack traces; it does not in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${is_dev ? " 'unsafe-eval'" : ""}`,
    // Dev serves styles as injected <style> tags that Next does not nonce.
    `style-src 'self' 'nonce-${nonce}'${is_dev ? " 'unsafe-inline'" : ""}`,
    // Signed Storage URLs point at the Supabase origin.
    `img-src 'self' blob: data: ${supabase_origin}`,
    "font-src 'self'",
    // Auth, PostgREST and the realtime socket.
    `connect-src 'self' ${supabase_origin} ${supabase_socket}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Refreshes the Supabase session cookie on every request so Server Components
 * never see an expired token, and attaches the CSP. Route protection itself is
 * enforced again in the page/route handlers — proxy runs at the edge and must
 * not be the only guard.
 */
export async function proxy(request: NextRequest) {
  const { url, anon_key } = supabase_env();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const csp = content_security_policy(nonce, url);

  // Rebuilt after every cookie write, because `request.cookies.set` rewrites the
  // `cookie` header and the refreshed token has to reach the Server Components.
  const request_headers = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    return headers;
  };

  const with_csp = (response: NextResponse) => {
    response.headers.set("Content-Security-Policy", csp);
    return response;
  };

  let response = NextResponse.next({ request: { headers: request_headers() } });

  const supabase = createServerClient(url, anon_key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookies_to_set) {
        for (const { name, value } of cookies_to_set) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request: { headers: request_headers() } });
        for (const { name, value, options } of cookies_to_set) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && pathname.startsWith("/dashboard")) {
    const login_url = request.nextUrl.clone();
    login_url.pathname = "/login";
    return with_csp(NextResponse.redirect(login_url));
  }

  if (user && pathname === "/login") {
    const dashboard_url = request.nextUrl.clone();
    dashboard_url.pathname = "/dashboard";
    return with_csp(NextResponse.redirect(dashboard_url));
  }

  return with_csp(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabase_env } from "@/lib/supabase/env";

/**
 * Refreshes the Supabase session cookie on every request so Server Components
 * never see an expired token. Route protection itself is enforced again in the
 * page/route handlers — proxy runs at the edge and must not be the only guard.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, anon_key } = supabase_env();

  const supabase = createServerClient(url, anon_key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookies_to_set) {
        for (const { name, value } of cookies_to_set) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
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
    return NextResponse.redirect(login_url);
  }

  if (user && pathname === "/login") {
    const dashboard_url = request.nextUrl.clone();
    dashboard_url.pathname = "/dashboard";
    return NextResponse.redirect(dashboard_url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

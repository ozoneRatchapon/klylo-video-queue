import { NextResponse } from "next/server";
import { supabase_server } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await supabase_server();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}

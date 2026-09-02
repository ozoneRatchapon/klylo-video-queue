import { redirect } from "next/navigation";
import { supabase_server } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await supabase_server();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? "/dashboard" : "/login");
}

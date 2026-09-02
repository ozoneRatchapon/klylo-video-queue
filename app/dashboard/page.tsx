import { redirect } from "next/navigation";
import { supabase_server } from "@/lib/supabase/server";
import { DashboardView } from "@/components/dashboard_view";
import type { job } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await supabase_server();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // RLS already restricts this to the current user; the filter is only an index hint.
  const { data: jobs, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Video jobs</h1>
          <p className="text-sm text-zinc-500">{user.email}</p>
        </div>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Sign out
          </button>
        </form>
      </header>

      <DashboardView
        user_id={user.id}
        initial_jobs={(jobs ?? []) as job[]}
        initial_error={error?.message ?? null}
      />
    </main>
  );
}

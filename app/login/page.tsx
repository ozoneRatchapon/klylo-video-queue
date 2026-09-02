import { redirect } from "next/navigation";
import { supabase_server } from "@/lib/supabase/server";
import { AuthForm } from "@/components/auth_form";

export default async function LoginPage() {
  const supabase = await supabase_server();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Klylo Video Queue</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Sign in to submit and track video jobs.
        </p>
        <AuthForm />
      </div>
    </main>
  );
}

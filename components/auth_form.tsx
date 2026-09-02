"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase_browser } from "@/lib/supabase/browser";

type auth_mode = "sign_in" | "sign_up";

export function AuthForm() {
  const router = useRouter();
  const [mode, set_mode] = useState<auth_mode>("sign_in");
  const [email, set_email] = useState("");
  const [password, set_password] = useState("");
  const [pending, set_pending] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const [notice, set_notice] = useState<string | null>(null);

  async function on_submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    set_pending(true);
    set_error(null);
    set_notice(null);

    const supabase = supabase_browser();

    switch (mode) {
      case "sign_in": {
        const { error: sign_in_error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (sign_in_error) {
          set_error(sign_in_error.message);
          set_pending(false);
          return;
        }
        break;
      }
      case "sign_up": {
        const { data, error: sign_up_error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (sign_up_error) {
          set_error(sign_up_error.message);
          set_pending(false);
          return;
        }
        // With email confirmation enabled there is no session yet.
        if (!data.session) {
          set_notice("Account created. Check your inbox to confirm, then sign in.");
          set_mode("sign_in");
          set_pending(false);
          return;
        }
        break;
      }
    }

    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={on_submit} className="mt-8 flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => set_email(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-300"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          type="password"
          required
          minLength={6}
          autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
          value={password}
          onChange={(event) => set_password(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-300"
        />
      </label>

      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
          {notice}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {pending ? "Please wait…" : mode === "sign_in" ? "Sign in" : "Create account"}
      </button>

      <button
        type="button"
        onClick={() => {
          set_mode(mode === "sign_in" ? "sign_up" : "sign_in");
          set_error(null);
          set_notice(null);
        }}
        className="text-sm text-zinc-500 underline underline-offset-4"
      >
        {mode === "sign_in" ? "No account? Sign up" : "Already have an account? Sign in"}
      </button>
    </form>
  );
}

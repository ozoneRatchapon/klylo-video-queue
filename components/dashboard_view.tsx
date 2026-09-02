"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AuthChangeEvent,
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  Session,
} from "@supabase/supabase-js";
import { supabase_browser } from "@/lib/supabase/browser";
import { JobForm } from "@/components/job_form";
import { JobCard } from "@/components/job_card";
import type { job } from "@/lib/types";

type realtime_state = "connecting" | "live" | "error";

function sort_desc(jobs: job[]): job[] {
  return [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function DashboardView({
  user_id,
  initial_jobs,
  initial_error,
}: {
  user_id: string;
  initial_jobs: job[];
  initial_error: string | null;
}) {
  const [jobs, set_jobs] = useState<job[]>(initial_jobs);
  const [error, set_error] = useState<string | null>(initial_error);
  const [realtime, set_realtime] = useState<realtime_state>("connecting");

  const upsert_job = useCallback((incoming: job) => {
    set_jobs((current) => {
      const exists = current.some((item) => item.id === incoming.id);
      const next = exists
        ? current.map((item) => (item.id === incoming.id ? incoming : item))
        : [incoming, ...current];
      return sort_desc(next);
    });
  }, []);

  const refetch = useCallback(async () => {
    const supabase = supabase_browser();
    const { data, error: fetch_error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });

    if (fetch_error) {
      set_error(fetch_error.message);
      return;
    }
    set_error(null);
    set_jobs((data ?? []) as job[]);
  }, []);

  useEffect(() => {
    const supabase = supabase_browser();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    // Realtime enforces RLS on the replication stream, so the socket must carry the
    // user's JWT *before* it joins. An anonymous join is accepted and reports
    // SUBSCRIBED, then silently delivers nothing — which is what a tab that restored
    // its session from cookies used to do. Setting it explicitly closes that race.
    // The listener then keeps the socket in step with refreshes and sign-outs.
    const { data: auth_listener } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        void supabase.realtime.setAuth(session?.access_token);
      },
    );

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      await supabase.realtime.setAuth(session?.access_token);
      if (cancelled) {
        return;
      }

      channel = supabase
        .channel(`jobs:${user_id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "jobs",
            filter: `user_id=eq.${user_id}`,
          },
          (payload: RealtimePostgresChangesPayload<job>) => {
            switch (payload.eventType) {
              case "INSERT":
              case "UPDATE":
                upsert_job(payload.new as job);
                break;
              case "DELETE":
                set_jobs((current) =>
                  current.filter(
                    (item) => item.id !== (payload.old as { id: string }).id,
                  ),
                );
                break;
            }
          },
        )
        .subscribe((status: string) => {
          switch (status) {
            case "SUBSCRIBED":
              set_realtime("live");
              // Catch up on anything that changed before the socket was ready.
              void refetch();
              break;
            case "CHANNEL_ERROR":
            case "TIMED_OUT":
            case "CLOSED":
              set_realtime("error");
              break;
          }
        });
    })();

    return () => {
      cancelled = true;
      auth_listener.subscription.unsubscribe();
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [user_id, upsert_job, refetch]);

  return (
    <div className="flex flex-col gap-8">
      <JobForm user_id={user_id} on_created={upsert_job} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Your jobs</h2>
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span
              className={`h-2 w-2 rounded-full ${
                realtime === "live"
                  ? "bg-emerald-500"
                  : realtime === "connecting"
                    ? "animate-pulse bg-amber-500"
                    : "bg-red-500"
              }`}
            />
            {realtime === "live"
              ? "Realtime connected"
              : realtime === "connecting"
                ? "Connecting…"
                : "Realtime disconnected"}
          </span>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void refetch()}
              className="underline"
            >
              Retry
            </button>
          </div>
        )}

        {jobs.length === 0 && !error ? (
          <p className="rounded border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No jobs yet. Submit one above.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {jobs.map((item) => (
              <li key={item.id}>
                <JobCard job={item} on_change={upsert_job} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

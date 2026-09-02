import { NextResponse } from "next/server";
import { supabase_server } from "@/lib/supabase/server";
import type { job_status } from "@/lib/types";

// The simulated worker sleeps 5–15 s, so the function must outlive the default 10 s budget.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 15_000;
const SUCCESS_RATE = 0.8;

const FAILURE_MESSAGES = [
  "Renderer crashed while decoding the reference image.",
  "Generation timed out on the simulated GPU pool.",
  "Model returned an empty frame sequence.",
];

/** Statuses a job may be (re)submitted from. `processing` is intentionally excluded. */
const SUBMITTABLE: job_status[] = ["queued", "failed"];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export async function POST(_request: Request, ctx: RouteContext<"/api/jobs/[id]/process">) {
  const { id } = await ctx.params;

  // Uses the caller's session only — RLS keeps every read/write scoped to their own jobs.
  // No `service_role` key is used anywhere in this app.
  const supabase = await supabase_server();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: job, error: read_error } = await supabase
    .from("jobs")
    .select("id, status, image_path")
    .eq("id", id)
    .maybeSingle();

  if (read_error) {
    return NextResponse.json({ error: read_error.message }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (!SUBMITTABLE.includes(job.status as job_status)) {
    return NextResponse.json(
      { error: `Job is ${job.status} and cannot be submitted to the worker.` },
      { status: 409 },
    );
  }

  // Conditional transition: `.in("status", SUBMITTABLE)` makes the claim atomic, so two
  // concurrent requests cannot both start processing the same job.
  const { data: claimed, error: claim_error } = await supabase
    .from("jobs")
    .update({ status: "processing", error_message: null, result_url: null })
    .eq("id", id)
    .in("status", SUBMITTABLE)
    .select("id, image_path")
    .maybeSingle();

  if (claim_error) {
    return NextResponse.json({ error: claim_error.message }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: "Job was already claimed." }, { status: 409 });
  }

  await sleep(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));

  const succeeded = Math.random() < SUCCESS_RATE;
  const outcome = succeeded
    ? {
        status: "done" as const,
        // Bucket is private, so we store the object path and sign it on read.
        result_url: claimed.image_path,
        error_message: null,
      }
    : {
        status: "failed" as const,
        result_url: null,
        error_message: pick(FAILURE_MESSAGES),
      };

  const { error: finalize_error } = await supabase
    .from("jobs")
    .update(outcome)
    .eq("id", id)
    .eq("status", "processing");

  if (finalize_error) {
    return NextResponse.json({ error: finalize_error.message }, { status: 500 });
  }

  return NextResponse.json({ id, status: outcome.status });
}

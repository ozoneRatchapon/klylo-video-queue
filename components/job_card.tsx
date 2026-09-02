"use client";

import { useState } from "react";
import { run_worker } from "@/lib/jobs";
import { SignedImage } from "@/components/signed_image";
import { useSignedUrl } from "@/lib/use_signed_url";
import { LocalTime } from "@/components/local_time";
import type { job, job_status } from "@/lib/types";

const STATUS_STYLES: Record<job_status, string> = {
  queued: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  processing: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function JobCard({
  job: item,
  on_change,
}: {
  job: job;
  on_change: (updated: job) => void;
}) {
  const [retrying, set_retrying] = useState(false);
  const [error, set_error] = useState<string | null>(null);

  // `result_url` holds the Storage object path; the bucket is private, so the actual
  // URL only exists once signed. Surfaced as a link so the result is inspectable.
  const result = useSignedUrl(item.status === "done" ? item.result_url : null);

  // Only a failed job can be resubmitted — queued/processing/done are not retryable.
  const can_retry = item.status === "failed" && !retrying;

  async function on_retry() {
    set_retrying(true);
    set_error(null);

    // Optimistic: realtime will confirm, but the button should react immediately.
    on_change({ ...item, status: "processing", error_message: null, result_url: null });

    try {
      await run_worker(item.id);
    } catch (retry_error) {
      set_error((retry_error as Error).message);
    } finally {
      set_retrying(false);
    }
  }

  return (
    <article className="flex gap-4 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex shrink-0 flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Reference</span>
        <SignedImage
          path={item.image_path}
          alt="Reference image"
          className="h-24 w-24 rounded object-cover"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-sm">{item.prompt}</p>
          <span
            className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[item.status]}`}
          >
            {item.status === "processing" ? "processing…" : item.status}
          </span>
        </div>

        <LocalTime iso={item.created_at} className="block text-xs text-zinc-500" />

        {item.status === "processing" && (
          <div className="h-1 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
            <div className="h-full w-1/3 animate-pulse rounded bg-amber-500" />
          </div>
        )}

        {item.status === "done" && item.result_url && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Result</span>
            <SignedImage
              path={item.result_url}
              alt="Job result"
              className="h-40 w-auto rounded object-contain"
            />
            {result.url && (
              <a
                href={result.url}
                target="_blank"
                rel="noreferrer"
                className="self-start text-xs text-zinc-500 underline"
              >
                Open signed result URL
              </a>
            )}
          </div>
        )}

        {item.status === "failed" && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {item.error_message ?? "Job failed."}
            </p>
            <button
              type="button"
              onClick={() => void on_retry()}
              disabled={!can_retry}
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </article>
  );
}

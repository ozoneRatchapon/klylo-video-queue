"use client";

import { useRef, useState } from "react";
import { supabase_browser } from "@/lib/supabase/browser";
import { run_worker } from "@/lib/jobs";
import { sniff_image_type } from "@/lib/image_sniff";
import {
  ALLOWED_IMAGE_TYPES,
  JOB_IMAGES_BUCKET,
  MAX_IMAGE_BYTES,
  type job,
} from "@/lib/types";

function validate_image(file: File | null): string | null {
  if (!file) {
    return "Please choose a reference image.";
  }
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return "Only JPG or PNG images are allowed.";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "Image must be 5 MB or smaller.";
  }
  return null;
}

export function JobForm({
  user_id,
  on_created,
}: {
  user_id: string;
  on_created: (created: job) => void;
}) {
  const file_input = useRef<HTMLInputElement>(null);
  const [prompt, set_prompt] = useState("");
  const [file, set_file] = useState<File | null>(null);
  const [pending, set_pending] = useState(false);
  const [error, set_error] = useState<string | null>(null);

  async function on_submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    set_error(null);

    const trimmed = prompt.trim();
    if (!trimmed) {
      set_error("Prompt is required.");
      return;
    }

    const image_error = validate_image(file);
    if (image_error || !file) {
      set_error(image_error);
      return;
    }

    // `file.type` comes from the extension, so confirm the bytes agree before
    // we label the stored object with it.
    const sniffed_type = await sniff_image_type(file);
    if (!sniffed_type) {
      set_error("That file is not a real JPG or PNG.");
      return;
    }

    set_pending(true);
    const supabase = supabase_browser();

    // Storage policies require the first path segment to be the owner's uid.
    const extension = sniffed_type === "image/png" ? "png" : "jpg";
    const image_path = `${user_id}/${crypto.randomUUID()}.${extension}`;

    const { error: upload_error } = await supabase.storage
      .from(JOB_IMAGES_BUCKET)
      .upload(image_path, file, { contentType: sniffed_type, upsert: false });

    if (upload_error) {
      set_error(`Upload failed: ${upload_error.message}`);
      set_pending(false);
      return;
    }

    const { data: created, error: insert_error } = await supabase
      .from("jobs")
      .insert({ user_id, prompt: trimmed, image_path, status: "queued" })
      .select("*")
      .single();

    if (insert_error || !created) {
      // Keep the bucket tidy if the row could not be created.
      await supabase.storage.from(JOB_IMAGES_BUCKET).remove([image_path]);
      set_error(`Could not create job: ${insert_error?.message ?? "unknown error"}`);
      set_pending(false);
      return;
    }

    on_created(created as job);
    set_prompt("");
    set_file(null);
    if (file_input.current) {
      file_input.current.value = "";
    }
    set_pending(false);

    // Fire the worker; status updates land through realtime.
    run_worker((created as job).id).catch((worker_error: Error) => {
      set_error(worker_error.message);
    });
  }

  return (
    <form
      onSubmit={on_submit}
      className="flex flex-col gap-4 rounded border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <h2 className="text-lg font-medium">New job</h2>

      <label className="flex flex-col gap-1 text-sm">
        Prompt
        <textarea
          required
          rows={3}
          maxLength={2000}
          value={prompt}
          onChange={(event) => set_prompt(event.target.value)}
          placeholder="A slow dolly shot through a neon-lit alley…"
          className="rounded border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-300"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Reference image (JPG/PNG, max 5 MB)
        <input
          ref={file_input}
          type="file"
          required
          accept="image/jpeg,image/png"
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            set_file(selected);
            set_error(validate_image(selected));
          }}
          className="text-sm file:mr-3 file:rounded file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-white dark:file:bg-zinc-100 dark:file:text-zinc-900"
        />
      </label>

      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {pending ? "Submitting…" : "Create job"}
      </button>
    </form>
  );
}

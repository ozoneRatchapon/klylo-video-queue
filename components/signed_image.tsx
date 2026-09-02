"use client";

import { useEffect, useState } from "react";
import { supabase_browser } from "@/lib/supabase/browser";
import { JOB_IMAGES_BUCKET } from "@/lib/types";

const SIGNED_URL_TTL_SECONDS = 60 * 10;

/** Renders a private Storage object through a short-lived signed URL. */
export function SignedImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt: string;
  className?: string;
}) {
  // Keyed by path so a path change falls back to the skeleton without a reset effect.
  const [signed, set_signed] = useState<{ path: string; url: string } | null>(null);
  const [failure, set_failure] = useState<{ path: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const supabase = supabase_browser();
      const { data, error: sign_error } = await supabase.storage
        .from(JOB_IMAGES_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

      if (cancelled) {
        return;
      }
      if (sign_error || !data) {
        set_failure({ path, message: sign_error?.message ?? "Could not sign image URL." });
        return;
      }
      set_signed({ path, url: data.signedUrl });
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  const url = signed?.path === path ? signed.url : null;
  const error = failure?.path === path ? failure.message : null;

  if (error) {
    return <span className="text-xs text-red-600 dark:text-red-400">{error}</span>;
  }

  if (!url) {
    return <span className={`block animate-pulse rounded bg-zinc-200 dark:bg-zinc-800 ${className ?? ""}`} />;
  }

  // Plain <img>: signed URLs are short-lived and per-user, so the Next image
  // optimizer would only add a cache layer we do not want here.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={className} />;
}

"use client";

import { useEffect, useState } from "react";
import { supabase_browser } from "@/lib/supabase/browser";
import { JOB_IMAGES_BUCKET } from "@/lib/types";

const SIGNED_URL_TTL_SECONDS = 60 * 10;

type signed_url = { url: string | null; error: string | null };

/**
 * Mints a short-lived signed URL for a private Storage object.
 * `null` path is a no-op, so callers can use this above a conditional render.
 */
export function useSignedUrl(path: string | null): signed_url {
  // Keyed by path so a path change falls back to the pending state without a reset effect.
  const [signed, set_signed] = useState<{ path: string; url: string } | null>(null);
  const [failure, set_failure] = useState<{ path: string; message: string } | null>(null);

  useEffect(() => {
    if (!path) {
      return;
    }
    let cancelled = false;

    void (async () => {
      const supabase = supabase_browser();
      const { data, error } = await supabase.storage
        .from(JOB_IMAGES_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

      if (cancelled) {
        return;
      }
      if (error || !data) {
        set_failure({ path, message: error?.message ?? "Could not sign image URL." });
        return;
      }
      set_signed({ path, url: data.signedUrl });
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  return {
    url: signed?.path === path ? signed.url : null,
    error: failure?.path === path ? failure.message : null,
  };
}

"use client";

import { useSignedUrl } from "@/lib/use_signed_url";

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
  const { url, error } = useSignedUrl(path);

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

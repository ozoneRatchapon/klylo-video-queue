"use client";

import { useSyncExternalStore } from "react";

/** Deterministic everywhere, so server and client agree on the first render. */
function utc_label(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The value never changes after mount, so there is nothing to subscribe to. */
function no_subscribe(): () => void {
  return () => {};
}

/**
 * Renders a timestamp without a hydration mismatch.
 *
 * `toLocaleString()` resolves against whatever locale and timezone the renderer
 * happens to be in — UTC on Vercel, the viewer's own settings in the browser —
 * so calling it during render makes the two passes disagree (React error #418).
 * `useSyncExternalStore` is the supported way to say so: the server snapshot is
 * a fixed UTC string used for SSR and hydration, and React swaps in the client
 * snapshot afterwards, when there is no server output left to match.
 */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const label = useSyncExternalStore(
    no_subscribe,
    () => new Date(iso).toLocaleString(),
    () => utc_label(iso),
  );

  return (
    <time dateTime={iso} className={className}>
      {label}
    </time>
  );
}

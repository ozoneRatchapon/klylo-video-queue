/** Suspense fallback for the dynamic dashboard — shown while jobs are fetched server-side. */
export default function DashboardLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading dashboard"
      className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-10"
    >
      <div className="h-9 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-56 animate-pulse rounded border border-zinc-200 dark:border-zinc-800" />

      <div className="flex flex-col gap-3">
        <div className="h-6 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        {[0, 1].map((row) => (
          <div
            key={row}
            className="h-32 animate-pulse rounded border border-zinc-200 dark:border-zinc-800"
          />
        ))}
      </div>
    </main>
  );
}

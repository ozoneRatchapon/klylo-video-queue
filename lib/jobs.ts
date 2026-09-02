/** Kicks the simulated worker for a job. Resolves when the worker finishes (5–15 s). */
export async function run_worker(job_id: string): Promise<void> {
  const response = await fetch(`/api/jobs/${job_id}/process`, { method: "POST" });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Worker failed with status ${response.status}`);
  }
}

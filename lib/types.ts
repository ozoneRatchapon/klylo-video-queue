export type job_status = "queued" | "processing" | "done" | "failed";

export type job = {
  id: string;
  user_id: string;
  prompt: string;
  image_path: string;
  status: job_status;
  result_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export const JOB_IMAGES_BUCKET = "job-images";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;

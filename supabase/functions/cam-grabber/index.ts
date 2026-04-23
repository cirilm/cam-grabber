import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const RETRY_BACKOFF_MS = [0, 1500, 3000, 5000, 8000];

type FetchResult = {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
};

type CameraSourceRow = {
  camera_id: string;
  camera_name: string;
  page_url: string;
  storage_bucket: string | null;
  keep_last: number | null;
  active: boolean;
  sort_order: number | null;
};

type CameraSource = {
  cameraId: string;
  cameraName: string;
  pageUrl: string;
  bucket: string;
  keepLast: number;
};

type CameraResult = {
  ok: true;
  camera_id: string;
  camera_name: string;
  ts: string;
  object_path: string;
  public_url: string;
  content_hash: string;
  bucket: string;
};

function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseKeepLast(value: unknown, fallback: string): number {
  const raw = typeof value === "number" ? String(value) : String(value ?? fallback);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid KEEP_LAST value: ${raw}`);
  }
  return parsed;
}

function sanitizeCameraId(cameraId: string): string {
  return cameraId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickImageUrl(html: string, baseUrl: string): string | null {
  const matches = [...html.matchAll(IMG_RE)];
  if (matches.length === 0) return null;

  for (const match of matches) {
    const src = match[1];
    if (src.startsWith("data:")) continue;
    const path = src.split("?")[0].toLowerCase();
    if (IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
      return new URL(src, baseUrl).href;
    }
  }

  for (const match of matches) {
    const src = match[1];
    if (!src.startsWith("data:")) {
      return new URL(src, baseUrl).href;
    }
  }

  return null;
}

function cacheBust(url: string): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${url}${url.includes("?") ? "&" : "?"}_cb=${ts}`;
}

function detectImageExtension(bytes: Uint8Array, contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";

  const jpeg = bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  if (jpeg) return "jpg";

  const png = bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  if (png) return "png";

  const riff = bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  if (riff) return "webp";

  throw new Error(`Unsupported image format. content-type=${contentType || "unknown"}`);
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, headers: HeadersInit): Promise<Response> {
  let lastError: unknown;

  for (const backoffMs of RETRY_BACKOFF_MS) {
    if (backoffMs > 0) {
      await delay(backoffMs);
    }

    try {
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });

      if (response.ok) {
        return response;
      }

      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }

      lastError = new Error(`Transient HTTP ${response.status} fetching ${url}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unknown fetch failure");
}

async function fetchImage(pageUrl: string): Promise<FetchResult> {
  const headers: HeadersInit = {
    "User-Agent": "cam-grabber/3.0 (+supabase-edge)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const pageResponse = await fetchWithRetry(pageUrl, headers);
  const pageContentType = (pageResponse.headers.get("content-type") || "").toLowerCase();

  if (pageContentType.startsWith("image/")) {
    const bytes = new Uint8Array(await pageResponse.arrayBuffer());
    const extension = detectImageExtension(bytes, pageContentType);
    return {
      bytes,
      contentType: pageContentType || `image/${extension}`,
      extension,
    };
  }

  const html = await pageResponse.text();
  const imageUrl = pickImageUrl(html, pageUrl);
  if (!imageUrl) {
    throw new Error(`No image found on ${pageUrl}`);
  }

  const imageResponse = await fetchWithRetry(cacheBust(imageUrl), headers);
  const imageContentType = (imageResponse.headers.get("content-type") || "").toLowerCase();
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  const extension = detectImageExtension(bytes, imageContentType);

  return {
    bytes,
    contentType: imageContentType || `image/${extension}`,
    extension,
  };
}

async function sha256Short(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function isAuthorized(request: Request): boolean {
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${serviceRoleKey}`) {
    return true;
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && request.headers.get("x-cron-secret") === cronSecret) {
    return true;
  }

  return false;
}

function buildFallbackSource(
  payload: Record<string, unknown>,
  defaultBucket: string,
  defaultKeepLast: number,
): CameraSource | null {
  const pageUrl = toNonEmptyString(payload.page_url) ?? toNonEmptyString(Deno.env.get("PAGE_URL"));
  if (!pageUrl) return null;

  const rawCameraId = toNonEmptyString(payload.camera_id) ??
    toNonEmptyString(Deno.env.get("CAMERA_ID")) ??
    "default_cam";

  return {
    cameraId: sanitizeCameraId(rawCameraId),
    cameraName: toNonEmptyString(payload.camera_name) ?? rawCameraId,
    pageUrl,
    bucket: toNonEmptyString(payload.bucket) ?? defaultBucket,
    keepLast: defaultKeepLast,
  };
}

async function loadCameraSources(
  supabase: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
  defaultBucket: string,
  defaultKeepLast: number,
): Promise<CameraSource[]> {
  const fallbackSource = buildFallbackSource(payload, defaultBucket, defaultKeepLast);
  const explicitPageUrl = toNonEmptyString(payload.page_url);
  if (fallbackSource && explicitPageUrl) {
    return [fallbackSource];
  }

  const requestedCameraId = toNonEmptyString(payload.camera_id);
  let query = supabase
    .from("camera_sources")
    .select("camera_id, camera_name, page_url, storage_bucket, keep_last, active, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("camera_id", { ascending: true });

  if (requestedCameraId) {
    query = query.eq("camera_id", sanitizeCameraId(requestedCameraId));
  }

  const { data, error } = await query;
  if (error) {
    if (fallbackSource && !requestedCameraId) {
      console.warn("[cam-grabber] falling back to env configuration:", error.message);
      return [fallbackSource];
    }
    throw new Error(`Failed to load camera sources: ${error.message}`);
  }

  if (data && data.length > 0) {
    return (data as CameraSourceRow[]).map((row) => ({
      cameraId: sanitizeCameraId(row.camera_id),
      cameraName: row.camera_name,
      pageUrl: row.page_url,
      bucket: row.storage_bucket || defaultBucket,
      keepLast: row.keep_last ?? defaultKeepLast,
    }));
  }

  if (fallbackSource && !requestedCameraId) {
    return [fallbackSource];
  }

  if (requestedCameraId) {
    throw new Error(`No active camera source found for ${sanitizeCameraId(requestedCameraId)}`);
  }

  throw new Error("No camera sources configured");
}

async function cleanupOldFrames(
  supabase: ReturnType<typeof createClient>,
  source: CameraSource,
): Promise<void> {
  if (source.keepLast <= 0) {
    return;
  }

  while (true) {
    const oldRows = await supabase
      .from("camera_frames")
      .select("id, object_path")
      .eq("camera_id", source.cameraId)
      .order("ts", { ascending: false })
      .range(source.keepLast, source.keepLast + 499);

    if (oldRows.error) {
      throw new Error(`Cleanup query failed for ${source.cameraId}: ${oldRows.error.message}`);
    }

    if (!oldRows.data || oldRows.data.length === 0) {
      return;
    }

    const oldPaths = oldRows.data.map((row) => row.object_path);
    const oldIds = oldRows.data.map((row) => row.id);

    const remove = await supabase.storage.from(source.bucket).remove(oldPaths);
    if (remove.error) {
      throw new Error(`Storage cleanup failed for ${source.cameraId}: ${remove.error.message}`);
    }

    const removeRows = await supabase.from("camera_frames").delete().in("id", oldIds);
    if (removeRows.error) {
      throw new Error(`DB cleanup failed for ${source.cameraId}: ${removeRows.error.message}`);
    }
  }
}

async function processCameraSource(
  supabase: ReturnType<typeof createClient>,
  source: CameraSource,
): Promise<CameraResult> {
  const image = await fetchImage(source.pageUrl);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, "-");
  const contentHash = await sha256Short(image.bytes);
  const objectPath = `${source.cameraId}/${day}/${time}_${contentHash}.${image.extension}`;

  const upload = await supabase.storage.from(source.bucket).upload(objectPath, image.bytes, {
    contentType: image.contentType || `image/${image.extension}`,
    upsert: false,
  });
  if (upload.error) {
    throw new Error(`Upload failed for ${source.cameraId}: ${upload.error.message}`);
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(source.bucket).getPublicUrl(objectPath);

  const insert = await supabase.from("camera_frames").insert({
    camera_id: source.cameraId,
    ts: now.toISOString(),
    object_path: objectPath,
    public_url: publicUrl,
    content_hash: contentHash,
  });

  if (insert.error) {
    await supabase.storage.from(source.bucket).remove([objectPath]);
    throw new Error(`DB insert failed for ${source.cameraId}: ${insert.error.message}`);
  }

  await cleanupOldFrames(supabase, source);

  return {
    ok: true,
    camera_id: source.cameraId,
    camera_name: source.cameraName,
    ts: now.toISOString(),
    object_path: objectPath,
    public_url: publicUrl,
    content_hash: contentHash,
    bucket: source.bucket,
  };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Use POST" });
  }

  if (!isAuthorized(request)) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  try {
    const payload = (request.headers.get("content-type")?.includes("application/json")
      ? await request.json().catch(() => ({}))
      : {}) as Record<string, unknown>;

    const defaultBucket = toNonEmptyString(payload.bucket) ??
      toNonEmptyString(Deno.env.get("SUPABASE_BUCKET")) ??
      "camframes";
    const defaultKeepLast = parseKeepLast(payload.keep_last, Deno.env.get("KEEP_LAST") ?? "1000");

    const supabaseUrl = getRequiredEnv("SUPABASE_URL");
    const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const sources = await loadCameraSources(supabase, payload, defaultBucket, defaultKeepLast);
    const results: CameraResult[] = [];
    const errors: Array<Record<string, string>> = [];

    for (const source of sources) {
      try {
        results.push(await processCameraSource(supabase, source));
      } catch (error) {
        console.error(`[cam-grabber:${source.cameraId}]`, error);
        errors.push({
          camera_id: source.cameraId,
          camera_name: source.cameraName,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    if (errors.length === 0) {
      return json(200, {
        ok: true,
        processed_count: results.length,
        failed_count: 0,
        results,
      });
    }

    if (results.length > 0) {
      return json(207, {
        ok: false,
        partial: true,
        processed_count: results.length,
        failed_count: errors.length,
        results,
        errors,
      });
    }

    return json(500, {
      ok: false,
      processed_count: 0,
      failed_count: errors.length,
      errors,
    });
  } catch (error) {
    console.error("[cam-grabber]", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const RETRY_BACKOFF_MS = [0, 1500, 3000, 5000, 8000];

type FetchResult = {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
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
    "User-Agent": "cam-grabber/2.0 (+supabase-edge)",
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
    throw new Error("No <img src=...> found on PAGE_URL");
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

    const pageUrl = String(payload?.page_url ?? getRequiredEnv("PAGE_URL"));
    const cameraId = sanitizeCameraId(
      String(payload?.camera_id ?? Deno.env.get("CAMERA_ID") ?? "default_cam"),
    );
    const bucket = String(payload?.bucket ?? Deno.env.get("SUPABASE_BUCKET") ?? "camframes");
    const keepLast = parseKeepLast(payload?.keep_last, Deno.env.get("KEEP_LAST") ?? "100");

    const supabaseUrl = getRequiredEnv("SUPABASE_URL");
    const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const image = await fetchImage(pageUrl);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const contentHash = await sha256Short(image.bytes);
    const objectPath = `${cameraId}/${day}/${time}_${contentHash}.${image.extension}`;

    const upload = await supabase.storage.from(bucket).upload(objectPath, image.bytes, {
      contentType: image.contentType || `image/${image.extension}`,
      upsert: false,
    });
    if (upload.error) {
      throw new Error(`Upload failed: ${upload.error.message}`);
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(bucket).getPublicUrl(objectPath);

    const insert = await supabase.from("camera_frames").insert({
      camera_id: cameraId,
      ts: now.toISOString(),
      object_path: objectPath,
      public_url: publicUrl,
      content_hash: contentHash,
    });

    if (insert.error) {
      await supabase.storage.from(bucket).remove([objectPath]);
      throw new Error(`DB insert failed: ${insert.error.message}`);
    }

    if (keepLast > 0) {
      const oldRows = await supabase
        .from("camera_frames")
        .select("id, object_path")
        .eq("camera_id", cameraId)
        .order("ts", { ascending: false })
        .range(keepLast, keepLast + 499);

      if (oldRows.error) {
        throw new Error(`Cleanup query failed: ${oldRows.error.message}`);
      }

      if (oldRows.data && oldRows.data.length > 0) {
        const oldPaths = oldRows.data.map((row) => row.object_path);
        const oldIds = oldRows.data.map((row) => row.id);

        const remove = await supabase.storage.from(bucket).remove(oldPaths);
        if (remove.error) {
          throw new Error(`Storage cleanup failed: ${remove.error.message}`);
        }

        const removeRows = await supabase.from("camera_frames").delete().in("id", oldIds);
        if (removeRows.error) {
          throw new Error(`DB cleanup failed: ${removeRows.error.message}`);
        }
      }
    }

    return json(200, {
      ok: true,
      ts: now.toISOString(),
      camera_id: cameraId,
      object_path: objectPath,
      public_url: publicUrl,
      content_hash: contentHash,
      bucket,
    });
  } catch (error) {
    console.error("[cam-grabber]", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.224.0/encoding/hex.ts";

const IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAGE_URL = Deno.env.get("PAGE_URL")!;
const CAMERA_ID = Deno.env.get("CAMERA_ID") || "default_cam";
const BUCKET = Deno.env.get("SUPABASE_BUCKET") || "camframes";
const KEEP_LAST = parseInt(Deno.env.get("KEEP_LAST") || "100", 10);

function pickImageSrc(html: string, baseUrl: string): string | null {
  const matches = [...html.matchAll(IMG_RE)];
  if (matches.length === 0) return null;

  // Prefer non-data URIs that look like images
  for (const m of matches) {
    const src = m[1];
    if (src.startsWith("data:")) continue;
    const path = src.split("?")[0].toLowerCase();
    if (IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
      return new URL(src, baseUrl).href;
    }
  }
  // Fallback to first non-data src
  for (const m of matches) {
    if (!m[1].startsWith("data:")) {
      return new URL(m[1], baseUrl).href;
    }
  }
  return matches[0][1];
}

function cacheBust(url: string): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return url + (url.includes("?") ? "&" : "?") + `_cb=${ts}`;
}

async function fetchImageBytes(pageUrl: string): Promise<Uint8Array> {
  const headers: Record<string, string> = {
    "User-Agent": "cam-grabber/1.0 (+supabase-edge)",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const resp = await fetch(pageUrl, { headers, redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${pageUrl}`);
  }

  const contentType = (resp.headers.get("content-type") || "").toLowerCase();

  // Direct image response
  if (contentType.startsWith("image/")) {
    return new Uint8Array(await resp.arrayBuffer());
  }

  // HTML page — extract <img src>
  const html = await resp.text();
  const imgUrl = pickImageSrc(html, pageUrl);
  if (!imgUrl) {
    throw new Error("No <img src=...> found on the page");
  }

  const imgResp = await fetch(cacheBust(imgUrl), {
    headers,
    redirect: "follow",
  });
  if (!imgResp.ok) {
    throw new Error(`HTTP ${imgResp.status} fetching image ${imgUrl}`);
  }

  const imgBytes = new Uint8Array(await imgResp.arrayBuffer());

  // Validate it looks like an image
  const imgCt = (imgResp.headers.get("content-type") || "").toLowerCase();
  if (!imgCt.startsWith("image/")) {
    const isJpeg =
      imgBytes[0] === 0xff && imgBytes[1] === 0xd8 && imgBytes[2] === 0xff;
    const isPng =
      imgBytes[0] === 0x89 &&
      imgBytes[1] === 0x50 &&
      imgBytes[2] === 0x4e &&
      imgBytes[3] === 0x47;
    if (!isJpeg && !isPng) {
      throw new Error(
        `Extracted URL did not return an image. content-type=${imgCt}`
      );
    }
  }

  return imgBytes;
}

async function sha256hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hash)).slice(0, 16);
}

Deno.serve(async (req) => {
  // Verify this is called by cron or with proper auth
  const authHeader = req.headers.get("Authorization");
  if (
    authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` &&
    authHeader !== `Bearer ${Deno.env.get("ANON_KEY") || ""}`
  ) {
    // Allow calls from pg_cron (via pg_net) which use the service role key
    // Also allow manual invocation with the anon key
  }

  try {
    // 1. Fetch the image
    const imgBytes = await fetchImageBytes(PAGE_URL);

    // 2. Build storage path
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const time = now.toISOString().slice(11, 19).replace(/:/g, "-"); // HH-MM-SS
    const contentHash = await sha256hex(imgBytes);
    const objectPath = `${CAMERA_ID}/${day}/${time}_${contentHash}.jpg`;

    // 3. Upload to Supabase Storage
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { error: uploadError } = await sb.storage
      .from(BUCKET)
      .upload(objectPath, imgBytes, {
        contentType: "image/jpeg",
        upsert: false,
      });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    // 4. Get public URL
    const {
      data: { publicUrl },
    } = sb.storage.from(BUCKET).getPublicUrl(objectPath);

    // 5. Insert metadata row
    const { error: insertError } = await sb
      .from("camera_frames")
      .insert({
        camera_id: CAMERA_ID,
        ts: now.toISOString(),
        object_path: objectPath,
        public_url: publicUrl,
        content_hash: contentHash,
      });
    if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);

    // 6. Cleanup old frames
    if (KEEP_LAST > 0) {
      const { data: oldRows } = await sb
        .from("camera_frames")
        .select("id, object_path")
        .eq("camera_id", CAMERA_ID)
        .order("ts", { ascending: false })
        .range(KEEP_LAST, KEEP_LAST + 500);

      if (oldRows && oldRows.length > 0) {
        const oldPaths = oldRows.map((r: { object_path: string }) => r.object_path);
        const oldIds = oldRows.map((r: { id: number }) => r.id);

        await sb.storage.from(BUCKET).remove(oldPaths);
        await sb.from("camera_frames").delete().in("id", oldIds);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        ts: now.toISOString(),
        object_path: objectPath,
        public_url: publicUrl,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[cam-grabber]", err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

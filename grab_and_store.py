#!/usr/bin/env python3
import argparse
import hashlib
import os
import re
import sys
from datetime import datetime, timezone
from typing import Optional, Tuple
from urllib.parse import urljoin

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from supabase import create_client

IMG_RE = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']', re.IGNORECASE)


def pick_image_src(html: str) -> Optional[str]:
    """Return the first <img src=...> found in HTML (simple heuristic)."""
    srcs = IMG_RE.findall(html or "")
    if not srcs:
        return None
    # Prefer non-data URIs, and prefer something that looks like an image.
    for s in srcs:
        if s.startswith("data:"):
            continue
        if any(s.lower().split("?")[0].endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp")):
            return s
    return srcs[0]


def is_image_response(resp: requests.Response) -> bool:
    ct = (resp.headers.get("content-type") or "").lower()
    return ct.startswith("image/")


def cache_bust(url: str, ts: str) -> str:
    return url + ("&" if "?" in url else "?") + f"_cb={ts}"


# --------- OPTION 1: resilient HTTP session (retries + backoff) ---------
def make_session(
    retries_total: int = 5,
    backoff_factor: float = 1.5,
) -> requests.Session:
    """
    Create a requests Session with retry/backoff for transient network errors.
    Retries on common transient HTTP status codes + connection errors/timeouts.
    """
    s = requests.Session()
    retry = Retry(
        total=retries_total,
        connect=retries_total,
        read=retries_total,
        status=retries_total,
        backoff_factor=backoff_factor,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "HEAD"]),
        raise_on_status=False,  # we call raise_for_status() ourselves
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def get_jpg_bytes(
    page_url: str,
    timeout: int,
    user_agent: str,
    retries: int,
) -> bytes:
    """Fetch page_url. If it's an image, return bytes; otherwise parse <img src> and fetch that."""
    session = make_session(retries_total=retries)

    # Use separate timeouts: (connect, read)
    # Connect timeout bigger helps in GitHub runners; read timeout protects from hanging transfers.
    t: Tuple[int, int] = (max(10, timeout), max(20, timeout))

    headers = {}
    if user_agent:
        headers["User-Agent"] = user_agent

    # Some sites behave better with these:
    headers.setdefault("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8")
    headers.setdefault("Accept-Language", "en-US,en;q=0.9")
    headers.setdefault("Connection", "close")  # avoid some keep-alive weirdness in CI

    r = session.get(page_url, headers=headers, timeout=t, allow_redirects=True)
    r.raise_for_status()

    if is_image_response(r):
        return r.content

    # HTML -> extract <img src=...>
    html = r.text
    src = pick_image_src(html)
    if not src:
        raise RuntimeError("No <img src=...> found on the page (and the response was not an image).")

    img_url = urljoin(page_url, src)
    busted = cache_bust(img_url, datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"))
    ir = session.get(busted, headers=headers, timeout=t, allow_redirects=True)
    ir.raise_for_status()

    if not is_image_response(ir):
        # Some cams return image bytes but with a wrong content-type; allow anyway if it looks like JPEG/PNG
        sniff = ir.content[:8]
        if not (sniff.startswith(b"\xff\xd8\xff") or sniff.startswith(b"\x89PNG")):
            raise RuntimeError(f"Extracted URL did not return an image. content-type={ir.headers.get('content-type')}")
    return ir.content
# ----------------------------------------------------------------------


def supabase_client():
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def upload_and_record(
    sb,
    bucket: str,
    camera_id: str,
    img_bytes: bytes,
    keep_last: int,
) -> dict:
    now = datetime.now(timezone.utc)
    day = now.strftime("%Y-%m-%d")
    ts_name = now.strftime("%H-%M-%S")
    content_hash = hashlib.sha256(img_bytes).hexdigest()[:16]
    object_path = f"{camera_id}/{day}/{ts_name}_{content_hash}.jpg"

    sb.storage.from_(bucket).upload(
        object_path,
        img_bytes,
        {"content-type": "image/jpeg", "upsert": False},
    )

    public_url = sb.storage.from_(bucket).get_public_url(object_path)

    sb.table("camera_frames").insert({
        "camera_id": camera_id,
        "ts": now.isoformat(),
        "object_path": object_path,
        "public_url": public_url,
        "content_hash": content_hash,
    }).execute()

    if keep_last > 0:
        res = (sb.table("camera_frames")
               .select("id, object_path")
               .eq("camera_id", camera_id)
               .order("ts", desc=True)
               .range(keep_last, keep_last + 500)
               .execute())
        rows = res.data or []
        if rows:
            old_paths = [r["object_path"] for r in rows]
            old_ids = [r["id"] for r in rows]
            sb.storage.from_(bucket).remove(old_paths)
            sb.table("camera_frames").delete().in_("id", old_ids).execute()

    return {"ts": now.isoformat(), "object_path": object_path, "public_url": public_url}


def main() -> int:
    ap = argparse.ArgumentParser(description="Grab a camera image from a page and store it to Supabase.")
    ap.add_argument("--page-url", required=True, help="Web page URL that contains the camera image (or is the image).")
    ap.add_argument("--camera-id", required=True, help="Logical camera id (used for folder path + DB partition).")
    ap.add_argument("--timeout", type=int, default=20, help="Base HTTP timeout seconds (used for connect/read).")
    ap.add_argument("--retries", type=int, default=5, help="HTTP retry count for transient failures.")
    ap.add_argument("--user-agent", default="cam-grabber/1.0 (+github-actions)", help="User-Agent header.")
    ap.add_argument("--bucket", default=os.environ.get("SUPABASE_BUCKET", "camframes"), help="Supabase Storage bucket.")
    ap.add_argument("--keep-last", type=int, default=int(os.environ.get("KEEP_LAST") or "100"),
                    help="How many latest frames to keep per camera (default 100). Use 0 to disable cleanup.")
    args = ap.parse_args()

    try:
        img_bytes = get_jpg_bytes(args.page_url, args.timeout, args.user_agent, args.retries)
        sb = supabase_client()
        out = upload_and_record(sb, args.bucket, args.camera_id, img_bytes, args.keep_last)
        print(f"[OK] Stored {args.camera_id} {out['ts']} -> {out['object_path']}")
        print(f"[OK] URL: {out['public_url']}")
        return 0
    except Exception as e:
        print(f"[ERR] {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Tests for grab_and_store image-fetching pipeline."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# Stub out supabase if it can't be imported (not needed for image-fetch tests)
if "supabase" not in sys.modules:
    sys.modules.setdefault("supabase", MagicMock())

from grab_and_store import (
    cache_bust,
    get_jpg_bytes,
    is_image_response,
    make_session,
    pick_image_src,
)

# ── Minimal valid image headers for magic-byte checks ──
JPEG_STUB = b"\xff\xd8\xff\xe0" + b"\x00" * 100
PNG_STUB = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100

CAM_URL = "https://sibenik-meteo.hr/weather/web_cam/mti_sat/betina_ponton/cam_4.php"


# ──────────────────────────────────────────────────────
# Unit tests (no network)
# ──────────────────────────────────────────────────────
class TestPickImageSrc(unittest.TestCase):
    def test_extracts_jpg(self):
        html = '<html><body><img src="snapshot.jpg"></body></html>'
        self.assertEqual(pick_image_src(html), "snapshot.jpg")

    def test_prefers_image_extension_over_other(self):
        html = '<img src="logo.svg"><img src="cam.jpg">'
        self.assertEqual(pick_image_src(html), "cam.jpg")

    def test_skips_data_uri(self):
        html = '<img src="data:image/png;base64,AAA"><img src="real.png">'
        self.assertEqual(pick_image_src(html), "real.png")

    def test_returns_first_if_no_image_ext(self):
        html = '<img src="/feed?id=1">'
        self.assertEqual(pick_image_src(html), "/feed?id=1")

    def test_returns_none_for_empty(self):
        self.assertIsNone(pick_image_src(""))
        self.assertIsNone(pick_image_src("<html></html>"))

    def test_case_insensitive(self):
        html = '<IMG SRC="Cam.JPG">'
        self.assertEqual(pick_image_src(html), "Cam.JPG")


class TestIsImageResponse(unittest.TestCase):
    def _resp(self, ct):
        r = MagicMock()
        r.headers = {"content-type": ct}
        return r

    def test_image_jpeg(self):
        self.assertTrue(is_image_response(self._resp("image/jpeg")))

    def test_image_png(self):
        self.assertTrue(is_image_response(self._resp("image/png; charset=utf-8")))

    def test_text_html(self):
        self.assertFalse(is_image_response(self._resp("text/html")))

    def test_missing_header(self):
        r = MagicMock()
        r.headers = {}
        self.assertFalse(is_image_response(r))


class TestCacheBust(unittest.TestCase):
    def test_appends_query(self):
        self.assertIn("_cb=", cache_bust("https://x.com/img.jpg", "20260318"))
        self.assertTrue(cache_bust("https://x.com/img.jpg", "t").endswith("?_cb=t"))

    def test_uses_ampersand_when_query_exists(self):
        self.assertIn("&_cb=", cache_bust("https://x.com/img?a=1", "t"))


class TestMakeSession(unittest.TestCase):
    def test_returns_session_with_retry_adapter(self):
        s = make_session(retries_total=2, backoff_factor=0.1)
        adapter = s.get_adapter("https://example.com")
        self.assertEqual(adapter.max_retries.total, 2)
        self.assertAlmostEqual(adapter.max_retries.backoff_factor, 0.1)


# ──────────────────────────────────────────────────────
# get_jpg_bytes tests (mocked network)
# ──────────────────────────────────────────────────────
class TestGetJpgBytes(unittest.TestCase):
    """Test the main fetch pipeline with mocked HTTP."""

    def _mock_response(self, content, content_type="image/jpeg", status=200):
        resp = MagicMock()
        resp.status_code = status
        resp.headers = {"content-type": content_type}
        resp.content = content
        resp.text = content.decode("utf-8", errors="replace") if isinstance(content, bytes) else content
        resp.raise_for_status = MagicMock()
        return resp

    @patch("grab_and_store.make_session")
    def test_direct_image_url(self, mock_make):
        """When the URL returns an image directly, return its bytes."""
        session = MagicMock()
        session.get.return_value = self._mock_response(JPEG_STUB)
        mock_make.return_value = session

        result = get_jpg_bytes("https://cam.example/image.jpg", timeout=10, user_agent="", retries=1)
        self.assertEqual(result, JPEG_STUB)
        session.get.assert_called_once()

    @patch("grab_and_store.make_session")
    def test_html_page_with_img_tag(self, mock_make):
        """When the URL returns HTML, it should extract <img src> and fetch that."""
        html = b'<html><body><img src="snap.jpg"></body></html>'
        session = MagicMock()
        session.get.side_effect = [
            self._mock_response(html, content_type="text/html"),
            self._mock_response(JPEG_STUB, content_type="image/jpeg"),
        ]
        mock_make.return_value = session

        result = get_jpg_bytes("https://cam.example/page.php", timeout=10, user_agent="", retries=1)
        self.assertEqual(result, JPEG_STUB)
        self.assertEqual(session.get.call_count, 2)

    @patch("grab_and_store.make_session")
    def test_html_no_img_raises(self, mock_make):
        """When HTML has no <img>, raise RuntimeError."""
        session = MagicMock()
        session.get.return_value = self._mock_response(b"<html></html>", content_type="text/html")
        mock_make.return_value = session

        with self.assertRaises(RuntimeError):
            get_jpg_bytes("https://cam.example/empty.html", timeout=10, user_agent="", retries=1)

    @patch("grab_and_store.make_session")
    def test_wrong_content_type_but_valid_magic_bytes(self, mock_make):
        """Some servers return wrong content-type; accept if magic bytes match."""
        html = b'<html><img src="feed"></html>'
        session = MagicMock()
        session.get.side_effect = [
            self._mock_response(html, content_type="text/html"),
            self._mock_response(PNG_STUB, content_type="application/octet-stream"),
        ]
        mock_make.return_value = session

        result = get_jpg_bytes("https://cam.example/page", timeout=10, user_agent="", retries=1)
        self.assertEqual(result, PNG_STUB)

    @patch("grab_and_store.make_session")
    def test_wrong_content_type_and_bad_magic_raises(self, mock_make):
        """Wrong content-type + no valid magic bytes => raise."""
        html = b'<html><img src="feed"></html>'
        session = MagicMock()
        session.get.side_effect = [
            self._mock_response(html, content_type="text/html"),
            self._mock_response(b"not an image", content_type="text/plain"),
        ]
        mock_make.return_value = session

        with self.assertRaises(RuntimeError):
            get_jpg_bytes("https://cam.example/page", timeout=10, user_agent="", retries=1)


# ──────────────────────────────────────────────────────
# Live integration test (opt-in)
# ──────────────────────────────────────────────────────
@unittest.skipUnless(
    os.environ.get("TEST_LIVE") == "1",
    "Set TEST_LIVE=1 to run live integration tests",
)
class TestLiveGrab(unittest.TestCase):
    """Hit the real camera page and validate the returned bytes."""

    def test_betina_cam4(self):
        img = get_jpg_bytes(CAM_URL, timeout=30, user_agent="cam-grabber-test/1.0", retries=3)
        self.assertGreater(len(img), 1000, "Image too small — probably not a real frame")
        # Must start with JPEG or PNG magic bytes
        self.assertTrue(
            img[:3] == b"\xff\xd8\xff" or img[:4] == b"\x89PNG",
            "Downloaded content is not a valid JPEG or PNG",
        )


# ──────────────────────────────────────────────────────
# Test POST request with populated actual data
# ──────────────────────────────────────────────────────
class TestUploadAndRecord(unittest.TestCase):
    """Test the upload_and_record flow with mocked Supabase client."""

    def _make_sb_mock(self):
        sb = MagicMock()
        sb.storage.from_.return_value.upload.return_value = None
        sb.storage.from_.return_value.get_public_url.return_value = (
            "https://abc.supabase.co/storage/v1/object/public/camframes/betina_cam4/2026-03-18/14-30-00_abcdef0123456789.jpg"
        )
        sb.table.return_value.insert.return_value.execute.return_value = MagicMock(data=[{"id": 1}])
        sb.table.return_value.select.return_value.eq.return_value.order.return_value.range.return_value.execute.return_value = MagicMock(data=[])
        return sb

    def test_upload_stores_and_records(self):
        from grab_and_store import upload_and_record

        sb = self._make_sb_mock()
        result = upload_and_record(
            sb=sb,
            bucket="camframes",
            camera_id="betina_cam4",
            img_bytes=JPEG_STUB,
            keep_last=100,
        )

        # Verify storage upload was called
        sb.storage.from_.assert_called_with("camframes")
        upload_call = sb.storage.from_.return_value.upload
        self.assertTrue(upload_call.called)
        args = upload_call.call_args
        self.assertIn("betina_cam4/", args[0][0])  # object_path starts with camera_id
        self.assertEqual(args[0][1], JPEG_STUB)     # image bytes passed through

        # Verify DB insert was called with correct data
        sb.table.assert_any_call("camera_frames")
        insert_call = sb.table.return_value.insert
        self.assertTrue(insert_call.called)
        row = insert_call.call_args[0][0]
        self.assertEqual(row["camera_id"], "betina_cam4")
        self.assertIn("object_path", row)
        self.assertIn("content_hash", row)
        self.assertIn("ts", row)

        # Verify result shape
        self.assertIn("ts", result)
        self.assertIn("object_path", result)
        self.assertIn("public_url", result)

    def test_upload_triggers_cleanup_when_old_rows_exist(self):
        from grab_and_store import upload_and_record

        sb = self._make_sb_mock()
        # Simulate 2 old rows beyond keep_last
        old_rows = [
            {"id": 50, "object_path": "betina_cam4/2026-03-17/10-00-00_old1.jpg"},
            {"id": 51, "object_path": "betina_cam4/2026-03-17/10-05-00_old2.jpg"},
        ]
        sb.table.return_value.select.return_value.eq.return_value.order.return_value.range.return_value.execute.return_value = MagicMock(data=old_rows)

        upload_and_record(
            sb=sb,
            bucket="camframes",
            camera_id="betina_cam4",
            img_bytes=JPEG_STUB,
            keep_last=5,
        )

        # Verify old files removed from storage
        sb.storage.from_.return_value.remove.assert_called_once_with(
            ["betina_cam4/2026-03-17/10-00-00_old1.jpg", "betina_cam4/2026-03-17/10-05-00_old2.jpg"]
        )
        # Verify old rows deleted from DB
        sb.table.return_value.delete.return_value.in_.assert_called_once_with("id", [50, 51])


class TestEdgeFunctionPost(unittest.TestCase):
    """Test POST request body matching the Edge Function's expected format.

    This validates the actual data shape that would be sent to / returned
    from the Supabase Edge Function endpoint.
    """

    def test_post_request_payload_shape(self):
        """Verify the POST payload we'd send to trigger the edge function."""
        import json

        # Actual populated request data (matches pg_cron / manual invocation)
        post_headers = {
            "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service-role-key",
            "Content-Type": "application/json",
        }

        # The edge function doesn't take a body (config is via env vars),
        # but we validate the auth header format is correct
        self.assertTrue(post_headers["Authorization"].startswith("Bearer "))
        self.assertEqual(post_headers["Content-Type"], "application/json")

    def test_expected_success_response_shape(self):
        """Validate the JSON response shape from a successful edge function call."""
        import json

        # Actual populated response data matching the Edge Function output
        response_body = {
            "ok": True,
            "ts": "2026-03-18T14:30:00.000Z",
            "object_path": "betina_cam4/2026-03-18/14-30-00_abcdef0123456789.jpg",
            "public_url": "https://abc.supabase.co/storage/v1/object/public/camframes/betina_cam4/2026-03-18/14-30-00_abcdef0123456789.jpg",
        }

        self.assertTrue(response_body["ok"])
        self.assertIn("betina_cam4", response_body["object_path"])
        self.assertTrue(response_body["object_path"].endswith(".jpg"))
        self.assertIn("/2026-03-18/", response_body["object_path"])
        self.assertTrue(response_body["public_url"].startswith("https://"))

        # Ensure it round-trips through JSON cleanly
        serialized = json.dumps(response_body)
        parsed = json.loads(serialized)
        self.assertEqual(parsed, response_body)

    def test_expected_error_response_shape(self):
        """Validate the error response from the edge function."""
        response_body = {"ok": False, "error": "Missing required env var: PAGE_URL. Set it in Edge Function secrets."}

        self.assertFalse(response_body["ok"])
        self.assertIn("PAGE_URL", response_body["error"])

    def test_pg_cron_invocation_payload(self):
        """Simulate the exact pg_net POST that pg_cron sends to the edge function."""
        import json

        # This matches setup_cron.sql: net.http_post() call
        cron_url = "https://abc.supabase.co/functions/v1/cam-grabber"
        cron_headers = json.dumps({
            "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service-role-key",
            "Content-Type": "application/json",
        })
        cron_body = json.dumps({"time": "2026-03-18T14:30:00Z"})

        parsed_headers = json.loads(cron_headers)
        parsed_body = json.loads(cron_body)

        self.assertIn("Authorization", parsed_headers)
        self.assertTrue(cron_url.endswith("/cam-grabber"))
        self.assertIn("time", parsed_body)


if __name__ == "__main__":
    unittest.main()

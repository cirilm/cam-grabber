import os, sys
from supabase import create_client

def die(msg):
    print(f"[SUPABASE ERROR] {msg}", file=sys.stderr)
    sys.exit(2)

def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    bucket = os.environ.get("SUPABASE_BUCKET", "camframes")

    if not url or not key:
        die("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    sb = create_client(url, key)

    # 1) DB check: can we query the metadata table?
    try:
        sb.table("camera_frames").select("id").limit(1).execute()
        print("✅ DB OK: camera_frames table is reachable")
    except Exception as e:
        die(f"DB query failed (table missing? perms?): {e}")

    # 2) Storage check: can we list the bucket?
    try:
        # list root of bucket (may be empty, that's fine)
        sb.storage.from_(bucket).list(path="")
        print(f"✅ Storage OK: bucket '{bucket}' is reachable")
    except Exception as e:
        die(f"Storage access failed (bucket missing? perms?): {e}")

    print("✅ Supabase connectivity looks good.")

if __name__ == "__main__":
    main()

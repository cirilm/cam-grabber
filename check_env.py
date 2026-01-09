import os
import sys

REQUIRED_SECRETS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
]

REQUIRED_VARS = [
    "PAGE_URL",
    "CAMERA_ID",
]

OPTIONAL_VARS = {
    "KEEP_LAST": "100",
    "SUPABASE_BUCKET": "camframes",
}

def fail(msg):
    print(f"[ENV ERROR] {msg}", file=sys.stderr)
    sys.exit(1)

def main():
    print("🔍 Checking environment configuration...\n")

    for key in REQUIRED_SECRETS:
        if not os.environ.get(key):
            fail(f"Missing required SECRET: {key}")
        print(f"✅ Secret present: {key} (hidden)")

    for key in REQUIRED_VARS:
        if not os.environ.get(key):
            fail(f"Missing required VARIABLE: {key}")
        print(f"✅ Variable present: {key} = {os.environ.get(key)}")

    for key, default in OPTIONAL_VARS.items():
        val = os.environ.get(key, default)
        print(f"ℹ️  Optional: {key} = {val}")

    # Basic sanity checks
    if not os.environ["PAGE_URL"].startswith("http"):
        fail("PAGE_URL does not look like a valid URL")

    try:
        int(os.environ.get("KEEP_LAST", "100"))
    except ValueError:
        fail("KEEP_LAST must be an integer")

    print("\n✅ Environment looks good. Ready to grab frames.")

if __name__ == "__main__":
    main()

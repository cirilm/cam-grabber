# Cam Grabber → Supabase (Storage + DB)

This repo runs a small Python “webcam grabber” every **5 minutes** via **GitHub Actions**.
It downloads the latest image from a webpage, uploads it to **Supabase Storage**, writes metadata to **Supabase Postgres**, and keeps only the **latest N** frames (default: 100) per camera.

## 1) Supabase setup

### A) Create a Storage bucket
Create a bucket, e.g. `camframes`.

- **Public bucket (simplest):** images are directly accessible by URL.
- **Private bucket (more secure):** you’ll later generate signed URLs (not implemented here by default).

### B) Create the metadata table
Run this in Supabase SQL Editor:

```sql
create table if not exists camera_frames (
  id bigserial primary key,
  camera_id text not null,
  ts timestamptz not null default now(),
  object_path text not null,
  public_url text,
  content_hash text
);

create index if not exists camera_frames_cam_ts
  on camera_frames (camera_id, ts desc);
```

Optional (light dedupe):
```sql
create unique index if not exists camera_frames_cam_hash_unique
  on camera_frames (camera_id, content_hash);
```

## 2) GitHub repo setup

### A) Add GitHub *Secrets*
In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

- `SUPABASE_URL` – your project URL
- `SUPABASE_SERVICE_ROLE_KEY` – **service role key** (keep it secret; do not put in mobile apps)

Optional:
- `SUPABASE_BUCKET` – defaults to `camframes`

### B) Add GitHub *Variables* (repo variables)
**Settings → Secrets and variables → Actions → Variables**

- `PAGE_URL` – the page URL you want to grab from
- `CAMERA_ID` – e.g. `betina_cam4`
- `KEEP_LAST` – e.g. `100` (optional)

## 3) Run it

- It will run automatically every 5 minutes.
- You can also run it manually: **Actions → cam-grabber → Run workflow**.

## 4) Reading the “stream” on mobile

If the bucket is **public**, the `public_url` field in `camera_frames` is a direct image URL.
To fetch the latest 100 frames for a camera:

```sql
select ts, public_url
from camera_frames
where camera_id = 'betina_cam4'
order by ts desc
limit 100;
```

You can query from:
- Supabase dashboard (quick check), or
- any mobile/web UI you build later.

## 5) Local run (optional)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export SUPABASE_URL="..."
export SUPABASE_SERVICE_ROLE_KEY="..."
export SUPABASE_BUCKET="camframes"

python grab_and_store.py --page-url "https://example.com/cam.php" --camera-id "betina_cam4"
```

## Notes
- This project intentionally **stores images in Storage** and only stores **metadata** in Postgres.
- GitHub Actions schedules can drift by ~minutes; for strict timing, use a VPS cron.

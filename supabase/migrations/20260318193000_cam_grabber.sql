create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.camera_frames (
  id bigserial primary key,
  camera_id text not null,
  ts timestamptz not null default now(),
  object_path text not null,
  public_url text,
  content_hash text
);

create index if not exists camera_frames_cam_ts
  on public.camera_frames (camera_id, ts desc);

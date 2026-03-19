# cam-grabber

`cam-grabber` now runs as a Supabase Edge Function instead of a GitHub Actions job.

## Source of truth

The GitHub repo owns:

- Edge Function code in `supabase/functions/cam-grabber/index.ts`
- database schema in `supabase/migrations/`
- function configuration in `supabase/config.toml`
- scheduler SQL in `supabase/setup_cron.sql`

The active hosted Supabase project used during review was `dyzwgcwzxhkfwgzafetl`, and its live state matched this repo shape:

- storage bucket: `camframes`
- table: `public.camera_frames`
- primary index: `camera_frames_cam_ts`
- active function slug: `cam-grabber`

## Required Edge Function secrets

Set these in Supabase before deploying:

- `PAGE_URL`
- `CAMERA_ID`
- `KEEP_LAST`
- `SUPABASE_BUCKET`

Optional but recommended:

- `CRON_SECRET`

Hosted Edge Functions already provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Deploy

```bash
supabase link --project-ref dyzwgcwzxhkfwgzafetl
supabase functions deploy cam-grabber
```

Because `supabase/config.toml` sets `verify_jwt = false`, the function does its own authorization:

- `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
- or `x-cron-secret: <CRON_SECRET>` when `CRON_SECRET` is configured

## Schema sync

The repo migration creates the extensions and table used by the function:

```bash
supabase db push
```

If you do not have a remote DB password configured locally yet, keep the migration in Git and apply it from the Supabase dashboard or after exporting `SUPABASE_DB_PASSWORD`.

## Scheduler

The scheduler uses `pg_cron` + `pg_net`, with its URL and cron secret stored in Supabase Vault.

The repo migration creates the cron job from Vault-backed values:

```bash
supabase db push
```

For a new environment, first create these Vault secrets from SQL:

```sql
create extension if not exists vault;

select vault.create_secret('https://dyzwgcwzxhkfwgzafetl.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET>', 'cam_grabber_cron_secret');
```

Then apply [setup_cron.sql](/Users/cirilmlakar/Documents/New%20project/cam-grabber/supabase/setup_cron.sql#L1) or run `supabase db push`.

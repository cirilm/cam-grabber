-- Enable required extensions (run once in Supabase SQL Editor)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Schedule the edge function to run every 5 minutes.
-- Replace <YOUR_SUPABASE_URL> and <YOUR_SERVICE_ROLE_KEY> with actual values.
select cron.schedule(
  'cam-grabber-every-5min',   -- unique job name
  '*/5 * * * *',              -- every 5 minutes
  $$
  select net.http_post(
    url    := '<SUPABASE_URL>/functions/v1/cam-grabber',
  headers := jsonb_build_object(
  'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>',  -- replace this
  'Content-Type',  'application/json'
),
    body   := '{}'::jsonb
  );
  $$
);

-- To verify the job was created:
-- select * from cron.job;

-- To remove the job later:
-- select cron.unschedule('cam-grabber-every-5min');

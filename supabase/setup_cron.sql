create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('cam-grabber-every-5min')
where exists (
  select 1
  from cron.job
  where jobname = 'cam-grabber-every-5min'
);

select cron.unschedule('weather-grabber-every-10min')
where exists (
  select 1
  from cron.job
  where jobname = 'weather-grabber-every-10min'
);

select cron.schedule(
  'cam-grabber-every-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://dyzwgcwzxhkfwgzafetl.supabase.co/functions/v1/cam-grabber',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := jsonb_build_object('source', 'pg_cron')
  );
  $$
);

select cron.schedule(
  'weather-grabber-every-10min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://dyzwgcwzxhkfwgzafetl.supabase.co/functions/v1/weather-grabber',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := jsonb_build_object('source', 'pg_cron')
  );
  $$
);

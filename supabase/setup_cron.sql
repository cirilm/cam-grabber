create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists vault;

select cron.unschedule('cam-grabber-every-5min')
where exists (
  select 1
  from cron.job
  where jobname = 'cam-grabber-every-5min'
);

select cron.schedule(
  'cam-grabber-every-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/cam-grabber',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cam_grabber_cron_secret')
    ),
    body := jsonb_build_object('source', 'pg_cron')
  );
  $$
);

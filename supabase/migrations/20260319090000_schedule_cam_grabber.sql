create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists vault;

do $$
begin
  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'project_url'
  ) and exists (
    select 1
    from vault.decrypted_secrets
    where name = 'cam_grabber_cron_secret'
  ) then
    perform cron.unschedule('cam-grabber-every-5min')
    where exists (
      select 1
      from cron.job
      where jobname = 'cam-grabber-every-5min'
    );

    perform cron.schedule(
      'cam-grabber-every-5min',
      '*/5 * * * *',
      $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
          || '/functions/v1/cam-grabber',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cam_grabber_cron_secret')
        ),
        body := jsonb_build_object('source', 'pg_cron')
      );
      $job$
    );
  end if;
end
$$;

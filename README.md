# cam-grabber

`cam-grabber` runs as Supabase Edge Functions and stores camera frames, live weather observations, and sea temperature observations in Supabase.

## Source of truth

The GitHub repo owns:

- camera ingestion code in `supabase/functions/cam-grabber/index.ts`
- weather ingestion code in `supabase/functions/weather-grabber/index.ts`
- sea temperature ingestion code in `supabase/functions/sea-temperature-grabber/index.ts`
- database schema in `supabase/migrations/`
- function configuration in `supabase/config.toml`
- scheduler SQL in `supabase/setup_cron.sql`

This branch keeps the existing `public.camera_frames` table and image history untouched. It adds:

- `public.camera_sources` to drive the active camera URLs
- `public.weather_observations` for current weather snapshots
- `public.sea_temperature_observations` for DHMZ sea temperature readings

## Camera sources

The migration seeds three active cameras:

- `betina_cam4` -> `https://sibenik-meteo.hr/weather/web_cam/mti_sat/betina_livo/cam_4.php`
- `betina_dizalica` -> `https://sibenik-meteo.hr/weather/web_cam/mti_sat/betina_dizalica/cam_4.php`
- `betina_ponton` -> `https://sibenik-meteo.hr/weather/web_cam/mti_sat/betina_ponton/cam_4.php`

`betina_cam4` stays in place so existing image history keeps the same `camera_id`.

## Weather data

`weather-grabber` stores current observations from:

- page: `https://www.wunderground.com/weather/hr/murter/IMURTER2`
- station: `IMURTER2`

Stored fields:

- `observed_at`
- `station_id`
- `condition_text`
- `temperature`
- `humidity`
- `pressure`
- `wind_speed`
- `wind_gust`
- `wind_direction`
- `dew_point`

Weather values are stored in metric units.

## Sea temperature data

`sea-temperature-grabber` stores all non-empty station/hour readings from:

- page: `https://meteo.hr/podaci.php?section=podaci_vrijeme&param=more_n`

Stored fields:

- `station_name`
- `station_slug`
- `observed_at`
- `observed_date`
- `observed_hour`
- `temperature_c`
- `is_buoy_sensor`
- `source_page_url`
- `fetched_at`

The function stores every visible station row from the DHMZ table, not just one location.

## Secrets and defaults

Shared scheduler secret:

- `CRON_SECRET`

Optional camera defaults and legacy single-camera fallback:

- `SUPABASE_BUCKET`
- `KEEP_LAST`
- `PAGE_URL`
- `CAMERA_ID`

Optional weather defaults:

- `WEATHER_PAGE_URL`
- `WEATHER_STATION_ID`

Optional sea temperature default:

- `SEA_TEMPERATURE_PAGE_URL`

Hosted Edge Functions already provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. This branch stores the normal multi-camera setup in `public.camera_sources`, so scheduled camera ingestion does not depend on `PAGE_URL` or `CAMERA_ID`.

## Deploy

```bash
supabase link --project-ref dyzwgcwzxhkfwgzafetl
supabase db push
supabase functions deploy cam-grabber
supabase functions deploy weather-grabber
supabase functions deploy sea-temperature-grabber
```

Because `supabase/config.toml` sets `verify_jwt = false`, all functions do their own authorization:

- `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
- or `x-cron-secret: <CRON_SECRET>`

## Function behavior

`cam-grabber`:

- with an empty POST body, processes every active row in `public.camera_sources`
- with `{"camera_id":"betina_ponton"}`, processes one configured camera
- with `{"page_url":"...","camera_id":"manual_cam"}`, processes a one-off source

`weather-grabber`:

- with an empty POST body, uses `WEATHER_PAGE_URL` and `WEATHER_STATION_ID`
- stores only current/live weather data, not forecast data

`sea-temperature-grabber`:

- with an empty POST body, uses `SEA_TEMPERATURE_PAGE_URL` or the built-in DHMZ page URL
- stores every non-empty station/hour cell shown on the page
- scheduled runs only write during the local Europe/Zagreb hours `08`, `11`, `14`, and `17`

## Scheduler

Run [setup_cron.sql](/Users/cirilmlakar/Documents/New%20project/cam-grabber/supabase/setup_cron.sql#L1) after replacing `<CRON_SECRET>` with the same value stored in Supabase secrets.

The repo-owned schedule is:

- `cam-grabber` every 5 minutes
- `weather-grabber` every 10 minutes
- `sea-temperature-grabber` every hour, with in-function writes limited to `08`, `11`, `14`, and `17` local time

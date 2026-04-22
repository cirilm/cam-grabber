create table if not exists public.camera_sources (
  id bigserial primary key,
  camera_id text not null unique,
  camera_name text not null,
  page_url text not null,
  storage_bucket text not null default 'camframes',
  keep_last integer not null default 1000 check (keep_last >= 0),
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists camera_sources_active_sort
  on public.camera_sources (active, sort_order, camera_id);

insert into public.camera_sources (
  camera_id,
  camera_name,
  page_url,
  storage_bucket,
  keep_last,
  sort_order,
  active
)
values
  (
    'betina_cam4',
    'Betina livo',
    'https://sibenik-meteo.hr/weather/web_cam/mti_sat/betina_livo/cam_4.php',
    'camframes',
    1000,
    10,
    true
  ),
  (
    'betina_dizalica',
    'Betina dizalica',
    'https://sibenik-meteo.hr/weather/web_cam/mti_sat/betina_dizalica/cam_4.php',
    'camframes',
    1000,
    20,
    true
  ),
  (
    'betina_ponton',
    'Betina ponton',
    'https://sibenik-meteo.hr/weather/web_cam/mti_sat/betina_ponton/cam_4.php',
    'camframes',
    1000,
    30,
    true
  )
on conflict (camera_id) do update
set
  camera_name = excluded.camera_name,
  page_url = excluded.page_url,
  storage_bucket = excluded.storage_bucket,
  keep_last = excluded.keep_last,
  sort_order = excluded.sort_order,
  active = excluded.active;

create table if not exists public.weather_observations (
  id bigserial primary key,
  observed_at timestamptz not null,
  station_id text not null,
  condition_text text,
  temperature double precision,
  humidity double precision,
  pressure double precision,
  wind_speed double precision,
  wind_gust double precision,
  wind_direction integer,
  dew_point double precision,
  created_at timestamptz not null default now()
);

create unique index if not exists weather_observations_station_observed_at
  on public.weather_observations (station_id, observed_at);

create index if not exists weather_observations_observed_at
  on public.weather_observations (observed_at desc);

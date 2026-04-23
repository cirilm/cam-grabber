create table if not exists public.sea_temperature_observations (
  id bigserial primary key,
  station_name text not null,
  station_slug text not null,
  observed_at timestamptz not null,
  observed_date date not null,
  observed_hour smallint not null check (observed_hour between 0 and 23),
  temperature_c double precision not null,
  is_buoy_sensor boolean not null default false,
  source_page_url text not null,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists sea_temperature_station_observed_at
  on public.sea_temperature_observations (station_slug, observed_at);

create index if not exists sea_temperature_observed_at_desc
  on public.sea_temperature_observations (observed_at desc);

create index if not exists sea_temperature_station_observed_at_desc
  on public.sea_temperature_observations (station_slug, observed_at desc);

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RETRY_BACKOFF_MS = [0, 1500, 3000, 5000, 8000];

type WeatherSnapshot = {
  observed_at: string;
  station_id: string;
  condition_text: string | null;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  wind_speed: number | null;
  wind_gust: number | null;
  wind_direction: number | null;
  dew_point: number | null;
};

type CurrentConditions = {
  wxPhraseLong?: unknown;
  temperature?: unknown;
  pressureMeanSeaLevel?: unknown;
  windSpeed?: unknown;
  windGust?: unknown;
  windDirection?: unknown;
  temperatureDewPoint?: unknown;
};

type PwsUnits = {
  temp?: unknown;
  dewpt?: unknown;
  windSpeed?: unknown;
  windGust?: unknown;
  pressure?: unknown;
};

type PwsObservation = {
  stationID?: unknown;
  obsTimeUtc?: unknown;
  humidity?: unknown;
  winddir?: unknown;
  metric?: PwsUnits;
  imperial?: PwsUnits;
};

function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, headers: HeadersInit): Promise<Response> {
  let lastError: unknown;

  for (const backoffMs of RETRY_BACKOFF_MS) {
    if (backoffMs > 0) {
      await delay(backoffMs);
    }

    try {
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });

      if (response.ok) {
        return response;
      }

      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }

      lastError = new Error(`Transient HTTP ${response.status} fetching ${url}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unknown fetch failure");
}

function isAuthorized(request: Request): boolean {
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${serviceRoleKey}`) {
    return true;
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && request.headers.get("x-cron-secret") === cronSecret) {
    return true;
  }

  return false;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

function fahrenheitToCelsius(value: number): number {
  return Number((((value - 32) * 5) / 9).toFixed(2));
}

function mphToKph(value: number): number {
  return Number((value * 1.609344).toFixed(2));
}

function inHgToHpa(value: number): number {
  return Number((value * 33.8638866667).toFixed(2));
}

function normalizePwsUnits(observation: PwsObservation): PwsUnits {
  if (observation.metric) {
    return observation.metric;
  }

  if (!observation.imperial) {
    return {};
  }

  return {
    temp: toNumber(observation.imperial.temp) === null
      ? null
      : fahrenheitToCelsius(toNumber(observation.imperial.temp) as number),
    dewpt: toNumber(observation.imperial.dewpt) === null
      ? null
      : fahrenheitToCelsius(toNumber(observation.imperial.dewpt) as number),
    windSpeed: toNumber(observation.imperial.windSpeed) === null
      ? null
      : mphToKph(toNumber(observation.imperial.windSpeed) as number),
    windGust: toNumber(observation.imperial.windGust) === null
      ? null
      : mphToKph(toNumber(observation.imperial.windGust) as number),
    pressure: toNumber(observation.imperial.pressure) === null
      ? null
      : inHgToHpa(toNumber(observation.imperial.pressure) as number),
  };
}

function decodeEmbeddedUrl(url: string): string {
  return url
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
}

function extractUrl(html: string, pattern: RegExp, label: string): string {
  const match = html.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${label} URL on weather page`);
  }
  return decodeEmbeddedUrl(match[0]);
}

function extractUrls(html: string, pattern: RegExp): string[] {
  return Array.from(html.matchAll(pattern), (match) => decodeEmbeddedUrl(match[0]));
}

function withQueryParam(url: string, key: string, value: string): string {
  const next = new URL(url);
  next.searchParams.set(key, value);
  return next.toString();
}

async function fetchJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const response = await fetchWithRetry(url, headers);
  return await response.json() as T;
}

async function fetchWeatherSnapshot(pageUrl: string, stationId: string): Promise<WeatherSnapshot> {
  const headers: HeadersInit = {
    "User-Agent": "weather-grabber/1.0 (+supabase-edge)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const pageResponse = await fetchWithRetry(pageUrl, headers);
  const html = await pageResponse.text();

  const currentUrl = withQueryParam(
    extractUrl(
      html,
      /https:\/\/api\.weather\.com\/v3\/wx\/observations\/current[^"'\\\s<]+/,
      "current conditions",
    ),
    "units",
    "m",
  );

  const pwsUrlCandidates = extractUrls(
    html,
    /https:\/\/api\.weather\.com\/v2\/pws\/observations\/current[^"'\\\s<]+/g,
  );
  const pwsMatch = pwsUrlCandidates.find((url) => url.includes(`stationId=${stationId}`));
  if (!pwsMatch) {
    throw new Error(`Could not find station observations URL for ${stationId}`);
  }
  const pwsUrl = withQueryParam(
    pwsMatch,
    "units",
    "m",
  );

  const [currentData, pwsData] = await Promise.all([
    fetchJson<CurrentConditions>(currentUrl, headers),
    fetchJson<{ observations?: PwsObservation[] }>(pwsUrl, headers),
  ]);

  const observation = pwsData.observations?.[0];
  if (!observation) {
    throw new Error(`No observation data returned for station ${stationId}`);
  }

  const units = normalizePwsUnits(observation);
  const observedAt = toNonEmptyString(observation.obsTimeUtc);
  const resolvedStationId = toNonEmptyString(observation.stationID) ?? stationId;
  if (!observedAt) {
    throw new Error(`Observation time missing for station ${resolvedStationId}`);
  }

  return {
    observed_at: observedAt,
    station_id: resolvedStationId,
    condition_text: toNonEmptyString(currentData.wxPhraseLong),
    temperature: toNumber(units.temp) ?? toNumber(currentData.temperature),
    humidity: toNumber(observation.humidity),
    pressure: toNumber(units.pressure) ?? toNumber(currentData.pressureMeanSeaLevel),
    wind_speed: toNumber(units.windSpeed) ?? toNumber(currentData.windSpeed),
    wind_gust: toNumber(units.windGust) ?? toNumber(currentData.windGust),
    wind_direction: toInteger(observation.winddir) ?? toInteger(currentData.windDirection),
    dew_point: toNumber(units.dewpt) ?? toNumber(currentData.temperatureDewPoint),
  };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Use POST" });
  }

  if (!isAuthorized(request)) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  try {
    const payload = (request.headers.get("content-type")?.includes("application/json")
      ? await request.json().catch(() => ({}))
      : {}) as Record<string, unknown>;

    const pageUrl = toNonEmptyString(payload.page_url) ??
      toNonEmptyString(Deno.env.get("WEATHER_PAGE_URL")) ??
      "https://www.wunderground.com/weather/hr/murter/IMURTER2";
    const stationId = toNonEmptyString(payload.station_id) ??
      toNonEmptyString(Deno.env.get("WEATHER_STATION_ID")) ??
      "IMURTER2";

    const snapshot = await fetchWeatherSnapshot(pageUrl, stationId);

    const supabaseUrl = getRequiredEnv("SUPABASE_URL");
    const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const write = await supabase
      .from("weather_observations")
      .upsert(snapshot, {
        onConflict: "station_id,observed_at",
      })
      .select()
      .single();

    if (write.error) {
      throw new Error(`DB upsert failed: ${write.error.message}`);
    }

    return json(200, {
      ok: true,
      weather: write.data,
      page_url: pageUrl,
    });
  } catch (error) {
    console.error("[weather-grabber]", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

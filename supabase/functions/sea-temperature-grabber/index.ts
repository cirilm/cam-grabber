import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RETRY_BACKOFF_MS = [0, 1500, 3000, 5000, 8000];
const RUN_HOURS_LOCAL = new Set([8, 11, 14, 17]);
const LOCAL_TIME_ZONE = "Europe/Zagreb";

type SeaTemperatureObservation = {
  station_name: string;
  station_slug: string;
  observed_at: string;
  observed_date: string;
  observed_hour: number;
  temperature_c: number;
  is_buoy_sensor: boolean;
  source_page_url: string;
  fetched_at: string;
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

function parseTemperature(raw: string): number | null {
  const normalized = raw.replace(",", ".").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLocalDateFromHeading(heading: string): { year: number; month: number; day: number } {
  const match = heading.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) {
    throw new Error(`Could not parse sea temperature date from heading: ${heading}`);
  }

  return {
    day: Number(match[1]),
    month: Number(match[2]),
    year: Number(match[3]),
  };
}

function formatObservedDate(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function getOffsetMillisecondsForTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );

  const zonedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );

  return zonedAsUtc - date.getTime();
}

function zagrebLocalTimeToUtcIso(
  parts: { year: number; month: number; day: number },
  hour: number,
): string {
  const guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, hour, 0, 0));
  const offsetMilliseconds = getOffsetMillisecondsForTimeZone(guess, LOCAL_TIME_ZONE);
  return new Date(guess.getTime() - offsetMilliseconds).toISOString();
}

function getCurrentLocalHour(timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
  return Number(hour);
}

function normalizeStationName(cell: HTMLTableCellElement): string {
  const clone = cell.cloneNode(true) as HTMLTableCellElement;
  clone.querySelectorAll("sup").forEach((node) => node.remove());
  return clone.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function toStationSlug(stationName: string): string {
  return stationName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shouldSkipScheduledRun(request: Request, payload: Record<string, unknown>): boolean {
  const force = payload.force === true || payload.force === "true";
  if (force) {
    return false;
  }

  if (request.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return false;
  }

  const localHour = getCurrentLocalHour(LOCAL_TIME_ZONE);
  return !RUN_HOURS_LOCAL.has(localHour);
}

async function fetchSeaTemperatureObservations(pageUrl: string): Promise<SeaTemperatureObservation[]> {
  const headers: HeadersInit = {
    "User-Agent": "sea-temperature-grabber/1.0 (+supabase-edge)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "hr,en;q=0.9",
  };

  const response = await fetchWithRetry(pageUrl, headers);
  const html = await response.text();
  const document = new DOMParser().parseFromString(html, "text/html");
  if (!document) {
    throw new Error("Could not parse DHMZ HTML");
  }

  const heading = document.querySelector("#primary h4")?.textContent?.trim();
  if (!heading) {
    throw new Error("Could not find sea temperature heading");
  }

  const localDateParts = parseLocalDateFromHeading(heading);
  const observedDate = formatObservedDate(localDateParts);
  const table = document.querySelector("#table-aktualni-podaci");
  if (!table) {
    throw new Error("Could not find sea temperature table");
  }

  const headerCells = Array.from(table.querySelectorAll("thead th"))
    .slice(1)
    .map((cell) => Number(cell.textContent?.trim() ?? ""))
    .filter((value) => Number.isFinite(value));

  if (headerCells.length === 0) {
    throw new Error("Sea temperature table has no measurement hours");
  }

  const fetchedAt = new Date().toISOString();
  const observations: SeaTemperatureObservation[] = [];

  for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
    const cells = Array.from(row.querySelectorAll("td"));
    if (cells.length < 2) continue;

    const stationName = normalizeStationName(cells[0] as HTMLTableCellElement);
    if (!stationName) continue;

    const stationSlug = toStationSlug(stationName);
    const isBuoySensor = cells[0].querySelector("sup")?.textContent?.trim() === "A";

    for (let index = 1; index < cells.length && index - 1 < headerCells.length; index += 1) {
      const temperature = parseTemperature(cells[index].textContent ?? "");
      if (temperature === null) continue;

      const observedHour = headerCells[index - 1];
      observations.push({
        station_name: stationName,
        station_slug: stationSlug,
        observed_at: zagrebLocalTimeToUtcIso(localDateParts, observedHour),
        observed_date: observedDate,
        observed_hour: observedHour,
        temperature_c: temperature,
        is_buoy_sensor: isBuoySensor,
        source_page_url: pageUrl,
        fetched_at: fetchedAt,
      });
    }
  }

  if (observations.length === 0) {
    throw new Error("Sea temperature table contained no numeric observations");
  }

  return observations;
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

    if (shouldSkipScheduledRun(request, payload)) {
      return json(200, {
        ok: true,
        skipped: true,
        reason: "Outside configured local run hours",
        local_time_zone: LOCAL_TIME_ZONE,
      });
    }

    const pageUrl = toNonEmptyString(payload.page_url) ??
      toNonEmptyString(Deno.env.get("SEA_TEMPERATURE_PAGE_URL")) ??
      "https://meteo.hr/podaci.php?section=podaci_vrijeme&param=more_n";

    const observations = await fetchSeaTemperatureObservations(pageUrl);
    const supabaseUrl = getRequiredEnv("SUPABASE_URL");
    const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const write = await supabase
      .from("sea_temperature_observations")
      .upsert(observations, {
        onConflict: "station_slug,observed_at",
      })
      .select("station_name, observed_at, observed_hour, temperature_c")
      .order("observed_at", { ascending: false })
      .limit(5);

    if (write.error) {
      throw new Error(`DB upsert failed: ${write.error.message}`);
    }

    return json(200, {
      ok: true,
      inserted_count: observations.length,
      page_url: pageUrl,
      latest_rows: write.data,
    });
  } catch (error) {
    console.error("[sea-temperature-grabber]", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

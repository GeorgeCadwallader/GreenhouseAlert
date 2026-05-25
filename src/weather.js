/**
 * @typedef {Object} ForecastHour
 * @property {string} time ISO 8601 hour start
 * @property {number} sustainedMph
 * @property {number} gustMph
 */

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

/**
 * Fetch hourly wind forecast from Open-Meteo.
 * @param {number} lat
 * @param {number} lon
 * @param {number} hours How many hours ahead to include (from now)
 * @returns {Promise<ForecastHour[]>}
 */
export async function fetchForecast(lat, lon, hours) {
  const forecastDays = Math.min(16, Math.max(1, Math.ceil(hours / 24) + 1));

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "wind_speed_10m,wind_gusts_10m",
    wind_speed_unit: "mph",
    forecast_days: String(forecastDays),
  });

  const url = `${OPEN_METEO_BASE}?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open-Meteo request failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  const hourly = data.hourly;

  if (!hourly?.time?.length) {
    throw new Error("Open-Meteo returned no hourly forecast data");
  }

  const now = Date.now();
  const end = now + hours * 60 * 60 * 1000;
  /** @type {ForecastHour[]} */
  const result = [];

  for (let i = 0; i < hourly.time.length; i++) {
    const time = hourly.time[i];
    const t = new Date(time).getTime();
    if (t < now || t > end) continue;

    const sustained = hourly.wind_speed_10m[i];
    const gust = hourly.wind_gusts_10m[i];

    if (sustained == null || gust == null) continue;

    result.push({
      time,
      sustainedMph: Number(sustained),
      gustMph: Number(gust),
    });
  }

  return result;
}

/**
 * Peak wind within a time window (inclusive).
 * @param {ForecastHour[]} forecast
 * @param {Date} windowStart
 * @param {Date} windowEnd
 */
export function peakInWindow(forecast, windowStart, windowEnd) {
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();

  let peakGust = 0;
  let peakSustained = 0;
  /** @type {string | null} */
  let peakGustHour = null;
  /** @type {string | null} */
  let peakSustainedHour = null;

  for (const hour of forecast) {
    const t = new Date(hour.time).getTime();
    if (t < startMs || t > endMs) continue;

    if (hour.gustMph >= peakGust) {
      peakGust = hour.gustMph;
      peakGustHour = hour.time;
    }
    if (hour.sustainedMph >= peakSustained) {
      peakSustained = hour.sustainedMph;
      peakSustainedHour = hour.time;
    }
  }

  return {
    peakGust,
    peakSustained,
    peakGustHour,
    peakSustainedHour,
  };
}

/**
 * Max wind across entire forecast slice (for daily history stats).
 * @param {ForecastHour[]} forecast
 */
export function maxAcrossForecast(forecast) {
  let maxGust = 0;
  let maxSustained = 0;

  for (const hour of forecast) {
    if (hour.gustMph > maxGust) maxGust = hour.gustMph;
    if (hour.sustainedMph > maxSustained) maxSustained = hour.sustainedMph;
  }

  return { maxGust, maxSustained };
}

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchForecast, peakInWindow, maxAcrossForecast } from "./weather.js";
import { sendNotification } from "./notify.js";
import {
  readState,
  writeState,
  recordRun,
  recordNotification,
  clearActiveBreach,
} from "./state.js";
import { registerSecrets, logError } from "./redact.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(ROOT, "config.json");

const dryRun = process.argv.includes("--dry-run");

// Load .env for local development (never committed)
try {
  const { config } = await import("dotenv");
  if (existsSync(join(ROOT, ".env"))) {
    config({ path: join(ROOT, ".env") });
  }
} catch {
  // dotenv is optional
}

/**
 * @returns {object}
 */
function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

/**
 * @returns {{ topic: string, lat: number, lon: number }}
 */
function loadSecrets() {
  const topic = process.env.NTFY_TOPIC?.trim();
  const latRaw = process.env.LOCATION_LAT?.trim();
  const lonRaw = process.env.LOCATION_LON?.trim();

  if (!topic) throw new Error("Missing secret: NTFY_TOPIC");
  if (!latRaw || !lonRaw) throw new Error("Missing secrets: LOCATION_LAT and LOCATION_LON");

  const lat = Number(latRaw);
  const lon = Number(lonRaw);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("LOCATION_LAT must be a number between -90 and 90");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error("LOCATION_LON must be a number between -180 and 180");
  }

  return { topic, lat, lon };
}

/**
 * @param {Date} date
 * @param {string} timezone
 */
function formatLocalTime(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * @param {number} ms
 */
function formatDuration(ms) {
  if (ms <= 0) return "now";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * @param {object} state
 * @param {object} config
 * @param {number} peakGust
 */
function shouldNotify(state, config, peakGust) {
  const last = state.current.lastBreach;
  if (!last) return { notify: true, reason: "first-breach" };

  const hoursSince =
    (Date.now() - new Date(last.notifiedAt).getTime()) / (3600 * 1000);

  if (hoursSince >= config.renotifyCooldownHours) {
    return { notify: true, reason: "cooldown-expired" };
  }

  if (peakGust - last.peakGustMph >= config.renotifyIfGustIncreasesByMph) {
    return { notify: true, reason: "gust-increased" };
  }

  return { notify: false, reason: null };
}

/**
 * @param {object} params
 */
function buildNotificationBody({
  peakGust,
  peakSustained,
  peakGustHour,
  gustThreshold,
  sustainedThreshold,
  timezone,
  reason,
}) {
  const peakDate = new Date(peakGustHour);
  const untilMs = peakDate.getTime() - Date.now();
  const localTime = formatLocalTime(peakDate, timezone);
  const prefix =
    reason === "gust-increased"
      ? "Updated forecast: "
      : reason === "test-override"
        ? "[Test] "
        : "";

  return (
    `${prefix}Gusts of ${Math.round(peakGust)} mph expected at ${localTime} (in ${formatDuration(untilMs)}). ` +
    `Sustained ${Math.round(peakSustained)} mph. ` +
    `Threshold gust ${gustThreshold} / sustained ${sustainedThreshold}.`
  );
}

async function main() {
  const config = loadConfig();
  const { topic, lat, lon } = loadSecrets();

  registerSecrets([
    topic,
    process.env.NTFY_TOPIC ?? "",
    process.env.LOCATION_LAT ?? "",
    process.env.LOCATION_LON ?? "",
    String(lat),
    String(lon),
  ]);

  console.log("GreenhouseAlert check starting");
  console.log("Location: lat=*** lon=***");
  if (dryRun) console.log("Dry run — no notification or state write");
  if (config.bypassAntiSpam) {
    console.log("bypassAntiSpam is ON — repeat alerts will not be suppressed");
  }

  const now = new Date();
  const nowIso = now.toISOString();

  const windowEnd = new Date(now.getTime() + config.leadTimeHours * 3600 * 1000);

  let state = readState();
  let hadError = false;

  try {
    const forecast = await fetchForecast(lat, lon, config.checkWindowHours);
    const { maxGust, maxSustained } = maxAcrossForecast(forecast);

    const { peakGust, peakSustained, peakGustHour } = peakInWindow(
      forecast,
      now,
      windowEnd
    );

    const breach =
      peakGust >= config.gustThresholdMph ||
      peakSustained >= config.sustainedThresholdMph;

    recordRun(state, {
      nowIso,
      hadError: false,
      maxGustMph: maxGust,
      maxSustainedMph: maxSustained,
      breach,
    });

    if (!breach) {
      clearActiveBreach(state);
      console.log(
        `No breach in next ${config.leadTimeHours}h (peak gust ${Math.round(peakGust)} mph, sustained ${Math.round(peakSustained)} mph)`
      );
      if (!dryRun) writeState(state);
      return;
    }

    const decision = config.bypassAntiSpam
      ? { notify: true, reason: "test-override" }
      : shouldNotify(state, config, peakGust);

    if (!decision.notify) {
      console.log(
        `Breach detected but suppressed (peak gust ${Math.round(peakGust)} mph, sustained ${Math.round(peakSustained)} mph)`
      );
      if (!dryRun) writeState(state);
      return;
    }

    const title =
      decision.reason === "gust-increased"
        ? "Greenhouse wind alert (updated)"
        : decision.reason === "test-override"
          ? "Greenhouse wind alert (test)"
          : "Greenhouse wind alert";

    const body = buildNotificationBody({
      peakGust,
      peakSustained,
      peakGustHour: peakGustHour ?? nowIso,
      gustThreshold: config.gustThresholdMph,
      sustainedThreshold: config.sustainedThresholdMph,
      timezone: config.timezone,
      reason: decision.reason,
    });

    console.log(`Would notify: ${decision.reason}`);
    console.log(`Message: ${body}`);

    if (!dryRun) {
      await sendNotification({
        topic,
        title,
        body,
        priority: "high",
        tags: ["wind_face", "warning"],
      });

      recordNotification(state, {
        at: nowIso,
        forPeakHour: peakGustHour ?? nowIso,
        gustMph: peakGust,
        sustainedMph: peakSustained,
        reason: decision.reason,
      });

      writeState(state);
      console.log("Notification sent and state updated");
    }
  } catch (err) {
    hadError = true;
    logError("Check failed", err);

    recordRun(state, {
      nowIso,
      hadError: true,
      maxGustMph: 0,
      maxSustainedMph: 0,
      breach: false,
    });

    if (!dryRun) writeState(state);
    process.exitCode = 1;
  }
}

main();

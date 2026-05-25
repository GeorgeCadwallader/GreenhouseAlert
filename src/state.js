import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "state");
const STATE_FILE = join(STATE_DIR, "state.json");
const HISTORY_DAYS = 7;

/**
 * @typedef {Object} NotificationRecord
 * @property {string} at
 * @property {string} forPeakHour
 * @property {number} gustMph
 * @property {number} sustainedMph
 * @property {'first-breach'|'cooldown-expired'|'gust-increased'} reason
 */

/**
 * @typedef {Object} DayHistory
 * @property {string} date YYYY-MM-DD
 * @property {number} runs
 * @property {number} errors
 * @property {number} maxGustForecastMph
 * @property {number} maxSustainedForecastMph
 * @property {number} breachesDetected
 * @property {number} notificationsSent
 * @property {NotificationRecord[]} notifications
 */

/**
 * @typedef {Object} StateFile
 * @property {{ lastRunAt: string | null, lastBreach: object | null }} current
 * @property {DayHistory[]} history
 */

/**
 * @returns {StateFile}
 */
function emptyState() {
  return {
    current: {
      lastRunAt: null,
      lastBreach: null,
    },
    history: [],
  };
}

/**
 * @param {string} iso
 * @returns {string}
 */
function dateKey(iso) {
  return iso.slice(0, 10);
}

/**
 * @param {StateFile} state
 * @param {string} today
 * @returns {DayHistory}
 */
function getOrCreateToday(state, today) {
  let day = state.history.find((h) => h.date === today);
  if (!day) {
    day = {
      date: today,
      runs: 0,
      errors: 0,
      maxGustForecastMph: 0,
      maxSustainedForecastMph: 0,
      breachesDetected: 0,
      notificationsSent: 0,
      notifications: [],
    };
    state.history.unshift(day);
  }
  return day;
}

/**
 * Keep only the last HISTORY_DAYS entries, newest first.
 * @param {StateFile} state
 */
function pruneHistory(state) {
  state.history.sort((a, b) => (a.date < b.date ? 1 : -1));
  state.history = state.history.slice(0, HISTORY_DAYS);
}

/**
 * @returns {StateFile}
 */
export function readState() {
  if (!existsSync(STATE_FILE)) {
    return emptyState();
  }

  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.current || !Array.isArray(parsed.history)) {
      return emptyState();
    }
    return parsed;
  } catch {
    return emptyState();
  }
}

/**
 * @param {StateFile} state
 */
export function writeState(state) {
  pruneHistory(state);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Record a completed check run for today.
 * @param {StateFile} state
 * @param {Object} run
 * @param {string} run.nowIso
 * @param {boolean} run.hadError
 * @param {number} run.maxGustMph
 * @param {number} run.maxSustainedMph
 * @param {boolean} run.breach
 */
export function recordRun(state, { nowIso, hadError, maxGustMph, maxSustainedMph, breach }) {
  const today = dateKey(nowIso);
  const day = getOrCreateToday(state, today);

  day.runs += 1;
  if (hadError) day.errors += 1;
  if (maxGustMph > day.maxGustForecastMph) day.maxGustForecastMph = maxGustMph;
  if (maxSustainedMph > day.maxSustainedForecastMph) {
    day.maxSustainedForecastMph = maxSustainedMph;
  }
  if (breach) day.breachesDetected += 1;

  state.current.lastRunAt = nowIso;
  pruneHistory(state);
}

/**
 * @param {StateFile} state
 * @param {Object} notification
 */
export function recordNotification(state, notification) {
  const today = dateKey(notification.at);
  const day = getOrCreateToday(state, today);

  day.notificationsSent += 1;
  day.notifications.push({
    at: notification.at,
    forPeakHour: notification.forPeakHour,
    gustMph: notification.gustMph,
    sustainedMph: notification.sustainedMph,
    reason: notification.reason,
  });

  state.current.lastBreach = {
    notifiedAt: notification.at,
    peakHour: notification.forPeakHour,
    peakGustMph: notification.gustMph,
    peakSustainedMph: notification.sustainedMph,
  };

  pruneHistory(state);
}

/**
 * Clear active breach tracking when forecast is calm again.
 * @param {StateFile} state
 */
export function clearActiveBreach(state) {
  state.current.lastBreach = null;
}

export { STATE_FILE };

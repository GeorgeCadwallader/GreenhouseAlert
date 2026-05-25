/** @type {string[]} */
let secrets = [];

/**
 * Register values that must never appear in logs.
 * @param {string[]} values
 */
export function registerSecrets(values) {
  secrets = values.filter(Boolean);
}

/**
 * Replace known secrets and coordinate-like numbers with ***.
 * @param {unknown} input
 * @returns {string}
 */
export function redact(input) {
  let text = String(input);

  for (const secret of secrets) {
    if (secret.length > 0) {
      text = text.split(secret).join("***");
    }
  }

  // Coordinate-like decimals (e.g. 51.5074, -0.1278)
  text = text.replace(/-?\d{1,3}\.\d{3,}/g, "***");

  return text;
}

/**
 * Safe console.error — always redacts registered secrets.
 * @param {string} message
 * @param {unknown} [detail]
 */
export function logError(message, detail) {
  const line = detail !== undefined ? `${message}: ${redact(detail)}` : message;
  console.error(redact(line));
}

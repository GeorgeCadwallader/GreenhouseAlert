const NTFY_BASE = "https://ntfy.sh";

/**
 * Send a push notification via ntfy.sh.
 * @param {Object} options
 * @param {string} options.topic
 * @param {string} options.title
 * @param {string} options.body
 * @param {string} [options.priority] default, low, high, urgent
 * @param {string[]} [options.tags]
 */
export async function sendNotification({ topic, title, body, priority = "high", tags = [] }) {
  const url = `${NTFY_BASE}/${encodeURIComponent(topic)}`;

  const headers = {
    Title: title,
    Priority: priority,
  };

  if (tags.length > 0) {
    headers.Tags = tags.join(",");
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`ntfy request failed: HTTP ${response.status}`);
  }
}

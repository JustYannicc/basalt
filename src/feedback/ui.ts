/**
 * The dashboard feedback form's contract. The form ships with the dashboard (patch 0047) and posts
 * to the submit endpoint, which validates against these limits.
 */
export const feedbackEndpoints = { submit: "/feedback/v1/submit" } as const;

const messageMax = 4000;
const screenshotBytesMax = 2 * 1024 * 1024;
const logBytesMax = 16_384;

export const feedbackLimits = {
  messageMax,
  /** Decoded bytes. */
  screenshotBytesMax,
  screenshotTypes: ["image/png", "image/jpeg"],
  errorsMax: 10,
  /** Recent page errors and failed requests; the form keeps the newest within these. */
  logEntriesMax: 50,
  /** UTF-8 bytes of the logs as JSON. */
  logBytesMax,
  logMessageMax: 1024,
  logPathMax: 1024,
  /**
   * A whole submission as JSON: the screenshot as base64, the message at four bytes a character
   * and the logs, with room for keys and escaping.
   */
  submitBodyBytesMax: Math.ceil(screenshotBytesMax / 3) * 4 + messageMax * 4 + logBytesMax * 2 + 4096,
} as const;

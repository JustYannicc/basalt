/**
 * The feedback button's contract. The browser half is the static, dependency-free
 * `public/feedback.js`; the router injects its tag into pages and the submit endpoint validates
 * against these limits, so all three read one copy.
 */
export const feedbackScriptPath = "/feedback.js";
/** Marks the tag, so a page that already carries it isn't given a second one. */
export const feedbackScriptMarker = "data-signalbox-feedback";
export const feedbackScriptTag = `<script src="${feedbackScriptPath}" defer ${feedbackScriptMarker}></script>`;

export const feedbackEndpoints = { submit: "/feedback/v1/submit", error: "/feedback/v1/error" } as const;

/** Every code the script sends. The server accepts these and nothing else. */
export const feedbackErrorCodes = [
  "script_error",
  "unhandled_rejection",
  "resource_error",
  "http_5xx",
  "feedback_submit_failed",
] as const;
export type FeedbackErrorCode = (typeof feedbackErrorCodes)[number];

export const feedbackLimits = {
  messageMax: 4000,
  /** Decoded bytes. */
  screenshotBytesMax: 2 * 1024 * 1024,
  screenshotTypes: ["image/png", "image/jpeg"],
  errorsMax: 10,
} as const;

interface RewriterInsert {
  before(content: string, options: { html: boolean }): unknown;
  append(content: string, options: { html: boolean }): unknown;
}
interface RewriterElement {
  onEndTag(handler: (end: Pick<RewriterInsert, "before">) => void): void;
}
/** The slice of Workers' `HTMLRewriter` this needs. */
export interface Rewriter {
  on(selector: string, handlers: { element(element: RewriterElement): void }): Rewriter;
  onDocument(handlers: { end(end: Pick<RewriterInsert, "append">): void }): Rewriter;
  transform(response: Response): Response;
}
type RewriterClass = new () => Rewriter;

/** Pages and error pages; a redirect or an empty body has nothing to show the button on. */
function isPage(response: Response): boolean {
  if (response.body === null || response.status < 200) return false;
  if (response.status >= 300 && response.status < 400) return false;
  return /^text\/html\b/i.test(response.headers.get("content-type") ?? "");
}

/**
 * Adds the feedback script before `</body>` of an HTML page, or at its end when the page never
 * closes its body. Other responses and pages that already carry the tag pass through unchanged.
 */
export function injectFeedback(
  response: Response,
  HTMLRewriter: RewriterClass = (globalThis as { HTMLRewriter?: RewriterClass }).HTMLRewriter!,
): Response {
  if (!isPage(response)) return response;
  let present = false;
  return new HTMLRewriter()
    .on(`script[${feedbackScriptMarker}]`, { element() { present = true; } })
    .on("body", {
      element(body) {
        body.onEndTag((end) => {
          if (present) return;
          present = true;
          end.before(feedbackScriptTag, { html: true });
        });
      },
    })
    .onDocument({ end(end) { if (!present) end.append(feedbackScriptTag, { html: true }); } })
    .transform(response);
}

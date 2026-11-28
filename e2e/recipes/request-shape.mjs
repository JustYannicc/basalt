/**
 * A page request as public evidence may show it: its method, its path with the organization and
 * every identifier-like segment cut, and how long it has been open. Host, query and fragment are
 * dropped, since they can carry tokens, ranges or another origin's name.
 */
export const requestShape = (method, url, openMs) => ({
  method,
  path: new URL(url).pathname
    .split("/")
    .map((segment, index, segments) =>
      ["organizations", "org"].includes(segments[index - 1] ?? "")
        ? ":organization"
        : /\d/.test(segment) && segment.length >= 8
          ? ":id"
          : segment,
    )
    .join("/"),
  openMs,
});

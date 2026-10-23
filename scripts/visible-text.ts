/**
 * What a person reads in an HTML document: its text, plus attributes browsers show or read
 * aloud. Scripts, styles and markup are dropped.
 */
export const visibleText = (html: string) =>
  [
    html
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " "),
    ...[...html.matchAll(/\s(?:alt|title|aria-label|placeholder)="([^"]*)"/g)].map(
      (match) => match[1],
    ),
  ].join(" ");

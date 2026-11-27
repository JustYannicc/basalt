/** The load proof's two prompts, which the check sends and the mock's fixtures answer. */
export const LONG_COUNT = 1500;
/** What the mock matches a long call by: the prompt's head, as the load driver words it. */
export const longMatch = `Count from 1 to ${LONG_COUNT}`;
export const longPrompt = `${longMatch}, one number per line, with nothing else.`;
export const shortPrompt = "Reply with exactly OK.";

/**
 * A load send's marker: its run, its call's trace id and its send number. It rides at the end of the
 * prompt, the one part of a call the pool passes to the mock unchanged; the fixtures match on the
 * prompt's head, so a marked prompt is answered the same.
 */
export const sendMarker = (run: string, trace: string, attempt: number) =>
  `lw-${run}-${trace}-${attempt}`;
export const markerPattern = /\blw-([0-9a-f]{16})-[0-9a-f]{32}-[1-9][0-9]{0,2}\b/u;
export const markedPrompt = (prompt: string, marker: string | undefined) =>
  marker === undefined ? prompt : `${prompt} Ref ${marker}.`;

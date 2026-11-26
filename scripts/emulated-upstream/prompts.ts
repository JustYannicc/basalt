/** The load proof's two prompts, which the check sends and the mock's fixtures answer. */
export const LONG_COUNT = 1500;
/** What the mock matches a long call by: the prompt's head, as the load driver words it. */
export const longMatch = `Count from 1 to ${LONG_COUNT}`;
export const longPrompt = `${longMatch}, one number per line, with nothing else.`;
export const shortPrompt = "Reply with exactly OK.";

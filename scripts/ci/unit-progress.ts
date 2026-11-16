import { relative } from "node:path";
import { Readable } from "node:stream";
import { spec, type TestEvent } from "node:test/reporters";

async function* progress(events: AsyncIterable<TestEvent>) {
  for await (const event of events) {
    if (event.type === "test:dequeue" || event.type === "test:complete") {
      const { file, name, line, column } = event.data;
      process.stderr.write(
        `OWNED_TEST ${JSON.stringify({
          phase: event.type === "test:dequeue" ? "start" : "complete",
          file: file ? relative(process.cwd(), file) : undefined,
          name,
          line,
          column,
          ...(event.type === "test:complete" ? { passed: event.data.details.passed } : {}),
        })}\n`,
      );
    }
    yield event;
  }
}

export default async function* reporter(events: AsyncIterable<TestEvent>) {
  yield* Readable.from(events).compose(progress).compose(new spec());
}

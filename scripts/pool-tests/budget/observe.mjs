// Observe the existing test's public requests without changing responses or deadlines.
import { appendFileSync } from 'node:fs';
const output = process.env.POOL_BUDGET_HTTP;
if (output) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const request = new Request(...args);
    const url = new URL(request.url);
    const relevant = (url.pathname === '/ready' && request.headers.has('authorization')) || url.pathname === '/v1/chat/completions';
    try {
      const response = await original(...args);
      if (relevant) appendFileSync(output, JSON.stringify({ atMs: Date.now(), path: url.pathname, status: response.status }) + '\n');
      return response;
    } catch (error) {
      if (relevant) appendFileSync(output, JSON.stringify({ atMs: Date.now(), path: url.pathname, error: error.name }) + '\n');
      throw error;
    }
  };
}

export function scenarios(size) {
  return [
    ...["chat", "responses", "messages"].map(protocol => ({ id: `${size}-${protocol}-probe`, protocol, users: 1, concurrency: 1, requests: 1, streamSeconds: 2, bodyBytes: 1024 })),
    ...[[1, 20], [200, 800], [200, 2000], [200, 4000], [5000, 5000]].map(([users, concurrency]) => ({ id: `${size}-${users}-${concurrency}`, users, concurrency, requests: concurrency, streamSeconds: 60, bodyBytes: 262144, startsPerSecond: 100 })),
    { id: `${size}-long`, users: 20, concurrency: 20, requests: 20, streamSeconds: 360, bodyBytes: 262144, rate: 1 },
  ];
}

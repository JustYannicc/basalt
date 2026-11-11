import { fixture } from "./native-device-fixture.ts";

export default {
  async fetch() {
    using f = await fixture();
    const user = String(f.db.user![0]!.id);
    const setup = (await fetch(
      `http://localhost:3000/fixture/intent?user=${encodeURIComponent(user)}`,
    ).then((response) => response.json())) as { intent: string; pool: string };
    const response = await f.request(
      "/device/decide",
      { user_code: f.user_code, accept: true },
      {
        "x-basalt-native-intent": setup.intent,
        "x-basalt-native-name": "Worker fixture",
        "x-basalt-native-pool": setup.pool,
        "x-basalt-native-models": "true",
        "x-basalt-native-tools": "false",
      },
    );
    return Response.json({
      status: response.status,
      body: await response.json(),
      grants: f.db.mcpGrant!.length,
      consents: f.db.oauthConsent!.length,
      state: await fetch("http://localhost:3000/fixture/state").then((result) => result.json()),
    });
  },
};

# Phone client

Use your Signalbox model pool and connected tools from an iPhone or Android phone. Sign in in the system browser, choose a pool and approve this phone's access. The phone keeps its grant in secure storage and sends work through the same native tunnel as the desktop client.

Try a model streams a reply from your pool. Find a tool searches connected apps, shows a tool's input type and accepts its JSON input. Calls that need approval or more input pause for your answer. An interrupted call is never repeated automatically. Check its app before starting it again.

Backgrounding stops active work. Returning checks the saved grant. Disconnect keeps sign-in saved; Sign out removes it locally. Revoke this phone removes its server access. These actions cannot undo a tool write that already happened.

## Development

Use Node.js 24.18.0 and Bun 1.4.4. This is a development client with separate development identifiers. It has no local server, agent subprocess or phone-control permissions.

```sh
bun install --cwd clients/mobile --frozen-lockfile
bun run --cwd clients/mobile typecheck
bun run --cwd clients/mobile export:ios
bun run --cwd clients/mobile export:android
bun run --cwd clients/mobile prebuild
bun run --cwd clients/mobile start
```

Set `EXPO_PUBLIC_CLIENT_SERVER_ORIGIN` when building against an isolated test server. This is a public server address, never a credential. Native projects are generated locally by prebuild and stay out of Git. Local simulator builds need the platform SDK and native dependencies. App interaction and screenshots use the T3 Device panel.

Signing, private-release identifiers and internal distribution remain gated by [#209](https://github.com/JustYannicc/basalt/issues/209). No store or internal-distribution build is configured here.

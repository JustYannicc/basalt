# Phone client

Use your Signalbox model pool and connected tools from an iPhone or Android phone. Sign in in the system browser, choose a pool and approve this phone's access. The phone keeps its grant in secure storage and sends work through the same native tunnel as the desktop client.

Try a model streams a reply from your pool. Find a tool searches connected apps, shows a tool's input type and accepts its JSON input. Calls that need approval or more input pause for your answer. An interrupted call is never repeated automatically. Check its app before starting it again.

The Android app updates itself from published releases. It checks on launch, when you return to it at most every six hours, and from **Check for updates**. It downloads a newer version in the background, checks its size and SHA-256 against the release, then offers **Install**. Android checks the release signature and asks you to confirm each install.

Backgrounding stops active work. Returning checks the saved grant and retries automatically while the app is open if the connection is interrupted. Reconnect checks it immediately. Disconnect keeps sign-in saved; Sign out removes it locally. Revoke this phone removes its server access. These actions cannot undo a tool write that already happened.

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

Set `EXPO_PUBLIC_CLIENT_SERVER_ORIGIN` when building against an isolated test server. This is a public server address, never a credential. Release builds read their update manifest from `EXPO_PUBLIC_CLIENT_UPDATE_MANIFEST` (an https URL), or from the brand's source repository's latest release; development builds never update themselves. Native projects are generated locally by prebuild and stay out of Git. Local simulator builds need the platform SDK and native dependencies. App interaction and screenshots use the T3 Device panel.

Builds use the development identifiers unless `SIGNALBOX_CLIENT_RELEASE=true`, which the clients release workflow sets for the published `run.signalbox.client` APK. Store and internal distribution remain gated by [#209](https://github.com/JustYannicc/basalt/issues/209).

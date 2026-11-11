The Signalbox apps connect your Mac, PC or phone to your Signalbox models and tools. Sign in with your Signalbox account at app.signalbox.run.

These builds aren't signed by Apple, Microsoft or Google yet. Each system shows a warning the first time you open one; the steps below get you past it.

## Mac

Download **Signalbox-mac-arm64.dmg**, for Macs with Apple silicon (M1 or later) on macOS 14 or newer. Open it and drag Signalbox to Applications. Signalbox lives in the menu bar: sign in, check your connection, see your apps, connect Claude Code or Codex, and open Signalbox in your browser for everything else.

The first time you open it, macOS says it can't check the app for malicious software:

1. Open Signalbox from Applications. When the warning appears, click **Done**.
2. Open **System Settings → Privacy & Security**. Scroll down to **Security**, click **Open Anyway** next to Signalbox, and confirm with your password or Touch ID.
3. Click **Open Anyway** once more. After that, the app opens normally.

To update, quit Signalbox from its menu, then open the new download and replace the app in Applications. Your sign-in, agent settings and local address are kept. Each new version needs **Open Anyway** once more, and macOS may ask whether Signalbox can use its saved "Signalbox Client" keychain item: click **Always Allow**.

If macOS says Signalbox **"is damaged and can't be opened"**, the app is fine: macOS says that about unsigned downloads. Open Terminal, run this, then open the app again:

```sh
xattr -dr com.apple.quarantine "/Applications/Signalbox.app"
```

## Android

On your phone, download **Signalbox-android.apk** and open it.

1. Android asks whether your browser may install apps. Tap **Settings**, turn on **Allow from this source**, then go back.
2. Tap **Install**. If Play Protect warns that it doesn't recognize the app, tap **More details → Install anyway**.

Later versions install over this one and keep your sign-in.

## iPhone and iPad

There's no download yet: iPhones only install apps from the App Store or TestFlight, and Signalbox isn't on either yet.

With a Mac, Xcode and a free Apple account, you can install it on your own iPhone from the source. Follow the [phone client guide](https://github.com/{repository}/blob/main/clients/mobile/README.md), then run `npx expo run:ios --device --configuration Release` in `clients/mobile` with the phone connected. Apple lets a free account's apps run for 7 days; run the command again to renew it.

## Windows

Download **Signalbox-windows-x64-setup.exe** and run it. If Windows says it protected your PC, click **More info → Run anyway**. **Signalbox-windows-x64.zip** is the same app without an installer.

## Linux

- **Signalbox-linux-x86_64.AppImage**: make it executable (`chmod +x Signalbox-linux-x86_64.AppImage`) and run it.
- **Signalbox-linux-amd64.deb**: `sudo apt install ./Signalbox-linux-amd64.deb`.

## Command line

For servers and terminals without a desktop. Needs Node.js 24.18 or newer:

```sh
npm install -g https://github.com/{repository}/releases/download/signalbox-clients-{version}/signalbox-cli.tgz
signalbox-client login
```

The [client guide](https://github.com/{repository}/blob/main/clients/README.md) covers connecting Claude Code and Codex.

## Obsidian

Signalbox Sync for Obsidian has its own release. Install it from **Connect Obsidian** in Signalbox.

## Check a download

**SHA256SUMS.txt** lists the SHA-256 of every file. On a Mac or Linux, run `shasum -a 256 <file>` and compare.

The Signalbox apps connect your Mac, PC or phone to your Signalbox models and tools. Sign in with your Signalbox account at app.signalbox.run.

## What's new in {version}

- **Waking from sleep no longer leaves you stuck.** If your computer or phone went to sleep while Signalbox was renewing its sign-in, the connection now picks up again by itself. When the renewal can't be completed anymore, Signalbox asks you to sign in again, instead of telling your agents to retry shortly over and over.
- **Claude Code keeps going when a request is cut off.** If the connection drops after Claude Code sends a request but before the answer starts, Claude Code is told to try again rather than ending its turn.
- **Tools-only devices show no pool.** A device you connected for tools only no longer shows a pool or offers one to choose. On Mac, Windows and Linux, models read **Not included in this connection**.
- **A connection log for problem reports.** The Mac, Windows and Linux apps keep one; see **If the connection drops** below.
- **Other apps on your computer can get their own key.** `signalbox-client agent add <id> models tools` gives an app such as a dictation or writing app its own local key, and prints it once with the addresses to put in that app's settings. If the command line has no profile of its own, it now uses the desktop app's connection, so the new key works in the running app at once.

Signalbox 0.2.1 or later updates itself to this version: on a Mac automatically, on an Android phone after you tap **Install** in the app. Otherwise, download the file for your system below.

These builds aren't signed by Apple, Microsoft or Google yet. Each system shows a warning the first time you open one; the steps below get you past it.

## Mac

Download **Signalbox-mac-arm64.dmg**, for Macs with Apple silicon (M1 or later) on macOS 14 or newer. Open it and drag Signalbox to Applications. Signalbox lives in the menu bar: sign in, check your connection, see your apps, connect Claude Code or Codex, and open Signalbox in your browser for everything else.

The first time you open it, macOS says it can't check the app for malicious software:

1. Open Signalbox from Applications. When the warning appears, click **Done**.
2. Open **System Settings → Privacy & Security**. Scroll down to **Security**, click **Open Anyway** next to Signalbox, and confirm with your password or Touch ID.
3. Click **Open Anyway** once more. After that, the app opens normally.

Signalbox updates itself: new versions download and install automatically, and the app restarts itself briefly, with no **Open Anyway**. To check right away, open **Connection** in the menu-bar panel and click **Check for Updates…**. If macOS asks whether Signalbox can use its saved "Signalbox Client" keychain item, click **Always Allow**.

If your copy doesn't update itself, it's from before automatic updates: install this one once by hand: quit Signalbox from its menu, open the new download and replace the app in Applications, then click **Open Anyway** once more. Your sign-in, agent settings and local address are kept.

If macOS says Signalbox **"is damaged and can't be opened"**, the app is fine: macOS says that about unsigned downloads. Open Terminal, run this, then open the app again:

```sh
xattr -dr com.apple.quarantine "/Applications/Signalbox.app"
```

## Android

On your phone, download **Signalbox-android.apk** and open it.

1. Android asks whether your browser may install apps. Tap **Settings**, turn on **Allow from this source**, then go back.
2. Tap **Install**. If Play Protect warns that it doesn't recognize the app, tap **More details → Install anyway**.

Signalbox updates itself: new versions download in the app; tap **Install** on its home screen and confirm. The first time, Android asks you to allow installs from Signalbox: tap **Settings**, turn on **Allow from this source**, then go back. Updates keep your sign-in.

If your copy doesn't offer updates, it's from before in-app updates: install this one once by hand, as above.

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

## If the connection drops

The Mac, Windows and Linux apps keep a private log of connection warnings, `connection.log`. When it fills up, the earlier part moves to `connection.log.1` next to it. Attach both when you report a problem:

- Mac: `~/Library/Application Support/Signalbox Client/connection/`
- Windows: `%APPDATA%\Signalbox Client\connection\`
- Linux: `~/.config/Signalbox Client/connection/`

They hold no sign-in tokens, keys or request contents, and together they stay under about 1 MB.

## Check a download

**SHA256SUMS.txt** lists the SHA-256 of every file. On a Mac or Linux, run `shasum -a 256 <file>` and compare.

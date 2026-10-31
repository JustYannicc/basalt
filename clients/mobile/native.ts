import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { tunnelLimits, tunnelProtocol } from "../contracts/tunnel.ts";
import type { SocketFactory, WireEvent } from "../contracts/transport.ts";
import { mobileController } from "./controller.ts";

const key = "signalbox.native-grant.v1";
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
// React Native accepts handshake headers; the DOM constructor type omits that third argument.
const NativeWebSocket: {
  new (url: string, protocol: string, options: { headers: Record<string, string> }): WebSocket;
} = WebSocket;
const socket: SocketFactory = (url, token) => {
  const connection = new NativeWebSocket(url, tunnelProtocol, {
    headers: { authorization: `Bearer ${token}` },
  });
  const pending: WireEvent[] = [];
  let listener: ((event: WireEvent) => void) | undefined;
  let stopped = false;
  const deliver = (event: WireEvent) => {
    if (stopped) return;
    if (listener) listener(event);
    else if (pending.length < 4) pending.push(event);
    else connection.close();
  };
  connection.onmessage = (event) => {
    if (
      typeof event.data !== "string" ||
      new TextEncoder().encode(event.data).length > tunnelLimits.frameBytes
    ) {
      deliver({ type: "error" });
      connection.close();
      return;
    }
    deliver({ type: "message", data: event.data });
  };
  connection.onerror = () => deliver({ type: "error" });
  connection.onclose = () => deliver({ type: "close" });
  return {
    send: (value) => connection.send(value),
    close: () => {
      stopped = true;
      connection.close();
    },
    listen: (receive) => {
      listener = receive;
      for (const event of pending.splice(0)) receive(event);
      return () => {
        listener = undefined;
        stopped = true;
      };
    },
  };
};
export const controller = mobileController({
  store: {
    read: async () => (await SecureStore.getItemAsync(key, options)) ?? undefined,
    write: (value) => SecureStore.setItemAsync(key, value, options),
    remove: () => SecureStore.deleteItemAsync(key, options),
  },
  socket,
  crypto: {
    randomBytes: () => Crypto.getRandomValues(new Uint8Array(32)),
    sha256: async (bytes) =>
      new Uint8Array(
        await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes)),
      ),
  },
  openApproval: (url) =>
    WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    }),
  closeApproval: () => {
    if (Platform.OS === "ios") {
      try {
        WebBrowser.dismissBrowser();
      } catch {}
    }
  },
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopDeviceName, mobileDeviceName } from "./device-name.ts";

test("a computer's network name reads as people would say it", () => {
  assert.equal(desktopDeviceName("Alex-MacBook-Pro.local"), "Alex MacBook Pro");
  assert.equal(desktopDeviceName("studio_mini"), "studio mini");
  assert.equal(desktopDeviceName("   "), undefined);
  assert.equal(desktopDeviceName("192.168.1.20"), undefined);
  assert.equal(desktopDeviceName("localhost.localdomain"), undefined);
  assert.equal(desktopDeviceName("<script>x"), "scriptx");
  assert.equal(Array.from(desktopDeviceName("a".repeat(200)) ?? "").length, 60);
});

test("a phone or tablet reports only its kind", () => {
  const platform = { isIosApp: false, isAndroidApp: false, isTablet: false };
  assert.equal(mobileDeviceName({ ...platform, isIosApp: true }), "iPhone");
  assert.equal(mobileDeviceName({ ...platform, isIosApp: true, isTablet: true }), "iPad");
  assert.equal(mobileDeviceName({ ...platform, isAndroidApp: true }), "Android phone");
  assert.equal(mobileDeviceName(platform), undefined);
});

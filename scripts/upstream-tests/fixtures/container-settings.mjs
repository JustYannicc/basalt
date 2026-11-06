import assert from "node:assert/strict";

const tree = process.argv[2] ?? "lib";
assert.ok(tree === "src" || tree === "lib");
const { equalApplicationSettings, equalContainerValues } = await import(
  new URL(
    `../../../node_modules/alchemy/${tree}/Cloudflare/Containers/ContainerConfiguration.${tree === "src" ? "ts" : "js"}`,
    import.meta.url,
  )
);
const constraints = { regions: ["EEUR", "WEUR"], jurisdiction: "eu" };
const declared = { maxInstances: 1, constraints };
const observed = { ...declared, instances: 1, schedulingPolicy: "default" };
const desiredConfiguration = { image: "fixture@sha256:unchanged", instanceType: "basic" };
const observedConfiguration = {
  image: desiredConfiguration.image,
  vcpu: 0.25,
  memory: "1GiB",
  memoryMib: 1024,
  disk: { size: "4GB", size_mb: 4000 },
};
const configurationEqual = equalContainerValues(observedConfiguration, desiredConfiguration);
const settingsEqual = equalApplicationSettings(observed, declared);
console.log(JSON.stringify({ configurationEqual, settingsEqual }));
assert.equal(configurationEqual, true);
assert.equal(settingsEqual, true, "an undeclared instance count is not desired-state drift");
assert.equal(equalApplicationSettings(observed, { ...declared, instances: 1 }), true);
assert.equal(equalApplicationSettings(observed, { ...declared, instances: 0 }), false);
assert.equal(equalApplicationSettings(observed, { ...declared, instances: 2 }), false);
assert.equal(equalApplicationSettings({ ...observed, instances: 0 }, declared), true);
assert.equal(equalApplicationSettings(observed, { ...declared, maxInstances: 2 }), false);
assert.equal(
  equalApplicationSettings(observed, { ...declared, constraints: { jurisdiction: "fedramp" } }),
  false,
);
assert.equal(equalApplicationSettings(observed, { ...declared, schedulingPolicy: "moon" }), false);
assert.equal(
  equalApplicationSettings(observed, { ...declared, affinities: { colocation: "datacenter" } }),
  false,
);
assert.equal(
  equalContainerValues(observedConfiguration, {
    ...desiredConfiguration,
    image: "fixture@sha256:changed",
  }),
  false,
);
assert.equal(
  equalContainerValues(observedConfiguration, { ...desiredConfiguration, command: ["changed"] }),
  false,
);

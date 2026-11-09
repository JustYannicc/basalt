"use strict";
const fs = require("node:fs/promises"),
  path = require("node:path");
exports.createReader = (base) => {
  const root = path.resolve(base);
  const target = (relative) => {
    if (
      typeof relative !== "string" ||
      !relative ||
      relative.includes("\\") ||
      relative.includes("\0") ||
      relative.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid vault-relative attachment path");
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep)) throw new Error("Attachment escaped its vault");
    return absolute;
  };
  const describe = (stat) => ({
    bytes: Number(stat.size),
    stamp: `${stat.ino}:${stat.mtimeNs}:${stat.size}`,
  });
  const snapshot = async (relative) => {
    try {
      const stat = await fs.stat(target(relative), { bigint: true });
      return stat.isFile() ? describe(stat) : null;
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    snapshot,
    async read(relative, expected, offset, length) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 1048576 ||
        offset + length > expected.bytes
      )
        throw new Error("Attachment read exceeds its range bound");
      const handle = await fs.open(target(relative), "r");
      try {
        const before = describe(await handle.stat({ bigint: true }));
        if (before.stamp !== expected.stamp || before.bytes !== expected.bytes)
          throw new Error("Local attachment changed");
        const bytes = Buffer.alloc(length),
          result = await handle.read(bytes, 0, length, offset),
          after = describe(await handle.stat({ bigint: true }));
        if (result.bytesRead !== length || after.stamp !== expected.stamp)
          throw new Error("Local attachment changed during its read");
        return Uint8Array.from(bytes);
      } finally {
        await handle.close();
      }
    },
  };
};

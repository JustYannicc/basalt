declare module "sha.js" {
  interface Hash {
    _len: number;
    _a: number;
    _b: number;
    _c: number;
    _d: number;
    _e: number;
    _f: number;
    _g: number;
    _h: number;
    update(data: Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export default function createHash(algorithm: "sha256"): Hash;
}

import { tunnelLimits } from "../../clients/contracts/tunnel.ts";
import type { TunnelSocket } from "./platform.ts";
import { modelDrainPayload } from "../pool/model-drain-contract.ts";

/** Receipts come from the node's bounded reader, never from arbitrary provider output. */
export class ModelDrain {
  private socket: TunnelSocket;
  private maximum: number;
  private sequence = 0;
  private pending = new Map<number, number>();
  private pendingBytes = 0;
  constructor(socket: TunnelSocket, maximum: number) {
    this.socket = socket;
    this.maximum = maximum;
  }
  get idle() {
    return this.pending.size === 0;
  }
  send(bytes: Uint8Array, text: boolean) {
    if (
      this.pending.size >= 256 ||
      this.pendingBytes + bytes.length > this.maximum + tunnelLimits.windowBytes ||
      this.sequence >= 0x7fff_ffff
    )
      throw new Error("Model consumer queue exceeded.");
    const sequence = ++this.sequence;
    const frame = new Uint8Array(5 + bytes.length);
    frame[0] = text ? 0 : 1;
    new DataView(frame.buffer).setUint32(1, sequence);
    frame.set(bytes, 5);
    this.pending.set(sequence, bytes.length);
    this.pendingBytes += bytes.length;
    this.socket.send(frame.buffer);
  }
  receive(data: unknown) {
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0)
      throw new Error("Invalid model consumer frame.");
    const frame = new Uint8Array(data);
    if (frame[0] === 2) {
      if (frame.length !== 9) throw new Error("Invalid model consumer receipt.");
      const view = new DataView(data);
      const sequence = view.getUint32(1),
        bytes = view.getUint32(5);
      if (this.pending.keys().next().value !== sequence || this.pending.get(sequence) !== bytes)
        throw new Error("Unbacked model consumer receipt.");
      this.pending.delete(sequence);
      this.pendingBytes -= bytes;
      return undefined;
    }
    if ((frame[0] !== 0 && frame[0] !== 1) || frame.length - 1 > this.maximum)
      throw new Error("Model consumer output exceeded.");
    return { bytes: modelDrainPayload(data, "output")!, text: frame[0] === 0 };
  }
  stop() {
    this.pending.clear();
    this.pendingBytes = 0;
  }
}

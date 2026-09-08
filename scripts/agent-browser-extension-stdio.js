#!/usr/bin/node

// Windows native messaging framing terminates at Chrome. This WSL relay adds
// only an authenticated transport-origin frame, then preserves every extension
// frame byte-for-byte so profile/tab authority stays in the broker and MV3 peer.
import net from "node:net";
import { isAbsolute, resolve } from "node:path";
import {
  MAX_EXTENSION_TO_HOST_MESSAGE_BYTES,
  MAX_HOST_TO_EXTENSION_MESSAGE_BYTES,
  NATIVE_TRANSPORT_SCHEMA,
  canonicalJson,
} from "./agent-browser-extension-protocol.js";

function fail(message) {
  process.stderr.write(`agent-browser-extension-stdio: ${message}\n`);
  process.exit(70);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--origin", "--native-socket"].includes(name) ||
      value === undefined ||
      values.has(name)
    ) {
      fail("invalid arguments");
    }
    values.set(name, value);
  }
  const origin = values.get("--origin");
  const nativeSocket =
    values.get("--native-socket") ??
    `/tmp/agent-browser-extension-${process.getuid()}/native.sock`;
  if (
    !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin ?? "") ||
    !isAbsolute(nativeSocket ?? "") ||
    resolve(nativeSocket) !== nativeSocket
  ) {
    fail("invalid transport binding");
  }
  return { origin, nativeSocket };
}

function encode(value) {
  const payload = Buffer.from(canonicalJson(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class ExactFrameForwarder {
  constructor(limit, write, onFailure) {
    this.buffer = Buffer.alloc(0);
    this.limit = limit;
    this.write = write;
    this.onFailure = onFailure;
    this.failed = false;
  }

  push(chunk) {
    if (this.failed || !Buffer.isBuffer(chunk)) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > this.limit) {
        this.failed = true;
        this.onFailure();
        return;
      }
      if (this.buffer.length < length + 4) {
        if (this.buffer.length > this.limit + 4) {
          this.failed = true;
          this.onFailure();
        }
        return;
      }
      const frame = this.buffer.subarray(0, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      this.write(frame);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const socket = net.createConnection({ path: args.nativeSocket });
let connected = false;

const stop = () => {
  socket.destroy();
  process.stdin.destroy();
};

// Chrome stdin carries extension-to-host messages (64 MiB); child stdout
// becomes host-to-extension output and must retain Chrome's 1 MiB ceiling.
const fromChrome = new ExactFrameForwarder(
  MAX_EXTENSION_TO_HOST_MESSAGE_BYTES,
  (frame) => socket.write(frame),
  () => fail("invalid Chrome frame"),
);
const fromBroker = new ExactFrameForwarder(
  MAX_HOST_TO_EXTENSION_MESSAGE_BYTES,
  (frame) => process.stdout.write(frame),
  () => fail("invalid broker frame"),
);

socket.once("connect", () => {
  connected = true;
  socket.write(
    encode({
      schema: NATIVE_TRANSPORT_SCHEMA,
      type: "transport",
      origin: args.origin,
    }),
  );
  process.stdin.on("data", (chunk) => fromChrome.push(chunk));
  process.stdin.resume();
});
socket.on("data", (chunk) => fromBroker.push(chunk));
socket.once("error", () => fail("broker connection failed"));
socket.once("close", () => {
  if (connected) process.exit(0);
  fail("broker connection closed");
});
process.stdin.once("end", stop);
process.stdin.once("error", stop);

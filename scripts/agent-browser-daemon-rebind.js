#!/usr/bin/node

import net from "node:net";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

const REQUEST_SCHEMA = "agent-browser.daemon-transport-rebind-request.v1";
const RESULT_SCHEMA = "agent-browser.daemon-transport-rebind-result.v1";
const MAX_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

function fail(reason) {
  const safe =
    typeof reason === "string" && /^[A-Za-z0-9 ._-]{1,160}$/.test(reason)
      ? reason
      : "bounded transport helper failure";
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      status: "transport-helper-failed",
      reason: safe,
    })}\n`,
  );
  process.exit(70);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--socket-root", "--session", "--socket", "--timeout-ms"].includes(
        name,
      ) ||
      value === undefined ||
      values.has(name)
    ) {
      fail("invalid helper arguments");
    }
    values.set(name, value);
  }
  if (values.size !== 4) fail("incomplete helper arguments");
  const timeoutMs = Number(values.get("--timeout-ms"));
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    fail("invalid helper timeout");
  }
  return {
    socketRoot: values.get("--socket-root"),
    session: values.get("--session"),
    socketPath: values.get("--socket"),
    timeoutMs,
  };
}

function readRequest(args) {
  let raw;
  try {
    raw = readFileSync(0);
  } catch {
    fail("handover request is unavailable");
  }
  if (raw.length === 0 || raw.length > MAX_MESSAGE_BYTES) {
    raw.fill(0);
    fail("handover request size is invalid");
  }
  let text;
  let request;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    request = JSON.parse(text);
  } catch {
    raw.fill(0);
    fail("handover request is invalid");
  }
  if (
    request?.schema !== REQUEST_SCHEMA ||
    request.session !== args.session ||
    request.daemon?.socketPath !== args.socketPath ||
    !/^[0-9a-f]{64}$/.test(request.requestId ?? "") ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    raw.fill(0);
    fail("handover request binding is invalid");
  }
  return { raw, text, request };
}

function assertSocket(args, request) {
  const uid = process.getuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(args.session) ||
    !isAbsolute(args.socketRoot) ||
    resolve(args.socketRoot) !== args.socketRoot ||
    args.socketPath !== join(args.socketRoot, `${args.session}.sock`) ||
    dirname(args.socketPath) !== args.socketRoot
  ) {
    fail("handover socket route is invalid");
  }
  let rootFd;
  try {
    const rootNamed = lstatSync(args.socketRoot, { bigint: true });
    if (
      rootNamed.isSymbolicLink() ||
      !rootNamed.isDirectory() ||
      Number(rootNamed.uid) !== uid ||
      Number(rootNamed.mode & 0o777n) !== 0o700 ||
      realpathSync(args.socketRoot) !== args.socketRoot
    ) {
      fail("handover socket root is unsafe");
    }
    rootFd = openSync(
      args.socketRoot,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_CLOEXEC ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const root = fstatSync(rootFd, { bigint: true });
    if (root.dev !== rootNamed.dev || root.ino !== rootNamed.ino) {
      fail("handover socket root changed");
    }
    const socket = lstatSync(`/proc/self/fd/${rootFd}/${args.session}.sock`, {
      bigint: true,
    });
    if (
      socket.isSymbolicLink() ||
      !socket.isSocket() ||
      Number(socket.uid) !== uid ||
      socket.dev.toString() !== request.daemon.socketDev ||
      socket.ino.toString() !== request.daemon.socketIno
    ) {
      fail("handover socket identity changed");
    }
  } catch {
    fail("handover socket is unavailable");
  } finally {
    if (rootFd !== undefined) closeSync(rootFd);
  }
}

function validateResponse(raw, requestId) {
  if (
    raw.length === 0 ||
    raw.length > MAX_MESSAGE_BYTES ||
    raw.at(-1) !== 0x0a ||
    raw.subarray(0, -1).includes(0x0a)
  ) {
    fail("handover response framing is invalid");
  }
  let response;
  try {
    response = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, -1)),
    );
  } catch {
    fail("handover response is invalid");
  }
  if (
    response?.schema !== RESULT_SCHEMA ||
    response.requestId !== requestId ||
    typeof response.ok !== "boolean" ||
    typeof response.status !== "string" ||
    /Bearer\s|authorization/i.test(raw.toString("utf8"))
  ) {
    fail("handover response binding is invalid");
  }
  return raw;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = readRequest(args);
  assertSocket(args, input.request);
  const requestId = input.request.requestId;
  if (input.request.renewed) input.request.renewed.authorization = "";

  const response = await new Promise((resolveResponse, rejectResponse) => {
    const socket = net.createConnection({ path: args.socketPath });
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectResponse(error);
      else resolveResponse(value);
    };
    const timer = setTimeout(
      () => finish(new Error("timeout")),
      args.timeoutMs,
    );
    timer.unref?.();
    socket.once("connect", () => {
      socket.write(input.text + "\n", "utf8", () => {
        input.raw.fill(0);
        input.text = "";
      });
    });
    socket.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_MESSAGE_BYTES) {
        finish(new Error("oversize"));
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(0x0a)) finish(null, Buffer.concat(chunks, total));
    });
    socket.once("error", () => finish(new Error("socket")));
    socket.once("end", () => finish(new Error("eof")));
  }).catch(() => fail("handover daemon exchange failed"));

  process.stdout.write(validateResponse(response, requestId));
}

await main();

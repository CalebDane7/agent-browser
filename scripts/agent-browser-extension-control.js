import net from "node:net";
import { isAbsolute, resolve } from "node:path";
import {
  CONTROL_SCHEMA,
  MAX_CONTROL_MESSAGE_BYTES,
  canonicalJson,
  isHex64,
  opaqueId,
} from "./agent-browser-extension-protocol.js";

export async function requestExtensionControl(socketPath, body, timeoutMs = 2_000) {
  if (
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error("invalid extension control request");
  }
  const id = opaqueId();
  const request = { schema: CONTROL_SCHEMA, id, ...body };
  const encoded = `${canonicalJson(request)}\n`;
  if (Buffer.byteLength(encoded) > MAX_CONTROL_MESSAGE_BYTES) {
    throw new Error("extension control request is oversized");
  }
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = net.createConnection({ path: socketPath });
    let text = "";
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    const timer = setTimeout(
      () => finish(new Error("extension control request timed out")),
      timeoutMs,
    );
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(encoded));
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      text += chunk;
      if (bytes > MAX_CONTROL_MESSAGE_BYTES) {
        finish(new Error("extension control response is oversized"));
        return;
      }
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      if (newline !== text.length - 1) {
        finish(new Error("extension control response framing is invalid"));
        return;
      }
      let response;
      try {
        response = JSON.parse(text.slice(0, -1));
      } catch {
        finish(new Error("extension control response JSON is invalid"));
        return;
      }
      if (
        response?.schema !== CONTROL_SCHEMA ||
        response.id !== id ||
        !isHex64(response.id) ||
        typeof response.ok !== "boolean"
      ) {
        finish(new Error("extension control response identity is invalid"));
        return;
      }
      if (!response.ok) {
        const error = new Error(response.error?.message ?? "extension control failed");
        error.code = response.error?.code ?? "BRIDGE_FAILED";
        if (typeof response.profileDirectory === "string") {
          error.profileDirectory = response.profileDirectory;
        }
        finish(error);
        return;
      }
      finish(null, response.result);
    });
    socket.once("error", () => finish(new Error("extension control socket is unavailable")));
    socket.once("close", () => {
      if (!settled) finish(new Error("extension control socket closed early"));
    });
  });
}

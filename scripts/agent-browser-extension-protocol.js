import { createHash, randomBytes } from "node:crypto";

export const EXTENSION_SCHEMA = "agent-browser.extension-bridge.v1";
export const NATIVE_TRANSPORT_SCHEMA = "agent-browser.native-transport.v1";
export const CONTROL_SCHEMA = "agent-browser.extension-control.v1";
export const PROFILE_CONFIG_SCHEMA = "agent-browser.extension-profiles.v1";

// Chrome's native-messaging limits are directional. Host stdout is capped at
// 1 MiB to protect Chrome, while extension messages sent to host stdin may be
// up to 64 MiB. Collapsing both directions to the smaller bound rejected valid
// full-fidelity CDP replies before they could reach the broker.
export const MAX_HOST_TO_EXTENSION_MESSAGE_BYTES = 1024 * 1024;
export const MAX_EXTENSION_TO_HOST_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
export const MAX_CDP_MESSAGE_BYTES = 4 * 1024 * 1024;

const HEX_64 = /^[0-9a-f]{64}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/;
// WHY: Chrome Stable may assign the first non-default profile the literal
// directory `Profile` (without a numeric suffix). Rejecting that real directory
// made the user's existing Person 1 profile impossible to enroll.
const PROFILE_DIRECTORY = /^(?:Default|Profile(?: [1-9][0-9]{0,3})?)$/;

const ALLOWED_CDP_DOMAINS = new Set([
  "Accessibility",
  "CSS",
  "DOM",
  "DOMDebugger",
  "Emulation",
  "Fetch",
  "Input",
  "Log",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Runtime",
  "Security",
]);

const DENIED_CDP_METHODS = new Set([
  "Network.clearBrowserCache",
  "Network.clearBrowserCookies",
  "Network.deleteCookies",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Page.bringToFront",
  "Page.setDownloadBehavior",
  "Runtime.addBinding",
]);

export function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function isHex64(value) {
  return typeof value === "string" && HEX_64.test(value);
}

export function isSession(value) {
  return typeof value === "string" && SESSION.test(value);
}

export function isAccount(value) {
  return typeof value === "string" && ACCOUNT.test(value);
}

export function isProfileDirectory(value) {
  return typeof value === "string" && PROFILE_DIRECTORY.test(value);
}

export function opaqueId() {
  return randomBytes(32).toString("hex");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function boundedError(code, message) {
  const safeCode = /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
    ? code
    : "INTERNAL_ERROR";
  const safeMessage =
    typeof message === "string"
      ? message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 240)
      : "Agent Browser bridge failed";
  return { code: safeCode, message: safeMessage };
}

export function validatePageCdpMethod(method) {
  if (typeof method !== "string" || method.length > 128) return false;
  if (DENIED_CDP_METHODS.has(method)) return false;
  const separator = method.indexOf(".");
  if (separator <= 0) return false;
  return ALLOWED_CDP_DOMAINS.has(method.slice(0, separator));
}

export function validateProfileConfig(value) {
  if (!exactKeys(value, ["schema", "extensionOrigin", "profiles"])) return false;
  if (
    value.schema !== PROFILE_CONFIG_SCHEMA ||
    !/^chrome-extension:\/\/[a-p]{32}\/$/.test(value.extensionOrigin) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 64
  ) {
    return false;
  }
  const accounts = new Set();
  const keys = new Set();
  for (const profile of value.profiles) {
    if (
      !exactKeys(profile, ["account", "profileDirectory", "profileKey"]) ||
      !isAccount(profile.account) ||
      !isProfileDirectory(profile.profileDirectory) ||
      !isHex64(profile.profileKey) ||
      accounts.has(profile.account) ||
      keys.has(profile.profileKey)
    ) {
      return false;
    }
    accounts.add(profile.account);
    keys.add(profile.profileKey);
  }
  return true;
}

export function validateExtensionHello(value) {
  return (
    exactKeys(value, [
      "schema",
      "type",
      "profileKey",
      "connectionEpoch",
      "extensionVersion",
    ]) &&
    value.schema === EXTENSION_SCHEMA &&
    value.type === "hello" &&
    isHex64(value.profileKey) &&
    isHex64(value.connectionEpoch) &&
    /^(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){0,3}$/.test(
      value.extensionVersion,
    )
  );
}

export function validateNativeTransportHello(value) {
  return (
    exactKeys(value, ["schema", "type", "origin"]) &&
    value.schema === NATIVE_TRANSPORT_SCHEMA &&
    value.type === "transport" &&
    /^chrome-extension:\/\/[a-p]{32}\/$/.test(value.origin)
  );
}

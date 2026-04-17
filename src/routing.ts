import { INTERNAL_ROUTING_HEADERS, ROUTING_ACCOUNT_KEY_HEADER, ROUTING_SOURCE_HEADER } from "./constants.js";
import type { HeaderObject } from "./types.js";
import { normalizeHeaderObject } from "./utils.js";

export function injectRoutingHeaders(headers: HeaderObject, accountKey: string) {
  return {
    ...normalizeHeaderObject(headers),
    [ROUTING_ACCOUNT_KEY_HEADER]: accountKey,
    [ROUTING_SOURCE_HEADER]: "model-resolution",
  };
}

export function stripRoutingHeaders(headers: HeaderObject) {
  return Object.fromEntries(
    Object.entries(normalizeHeaderObject(headers)).filter(
      ([key]) => !INTERNAL_ROUTING_HEADERS.has(key.toLowerCase()),
    ),
  );
}

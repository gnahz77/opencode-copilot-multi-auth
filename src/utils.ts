import { RESPONSES_API_ALTERNATE_INPUT_TYPES } from "./constants.js";
import type { ConversationMetadata, HeaderObject } from "./types.js";

type JsonRecord = Record<string, unknown>;
type MessagePart = { type?: string };
type ChatMessage = { role?: string; content?: MessagePart[] };
type ResponsesInputItem = { role?: string; type?: string; content?: MessagePart[] };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object";
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body === "string") {
    return JSON.parse(body);
  }

  return body;
}

export function normalizeHeaderObject(headers: HeaderObject): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  const objectHeaders = headers as Record<string, unknown>;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(objectHeaders)) {
    normalized[key] = String(value);
  }

  return normalized;
}

export function normalizeList(value: unknown): string[] {
  return Array.isArray(value) ? value : [];
}

export function normalizePriority(value: unknown): number {
  return Number.isInteger(value) ? (value as number) : 0;
}

export function normalizeDomain(urlOrDomain: unknown): string {
  if (!urlOrDomain || typeof urlOrDomain !== "string") {
    return "github.com";
  }

  const value = urlOrDomain.trim();
  if (!value) {
    return "github.com";
  }

  try {
    const parsed = value.includes("://")
      ? new URL(value)
      : new URL(`https://${value}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return value
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  }
}

export function normalizeIdSource(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function preserveStringOrDefault(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return fallback;
}

export function zeroCost() {
  return {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

export function isLiveChatModel(model: unknown): boolean {
  if (!isRecord(model)) {
    return false;
  }

  const capabilities = model.capabilities;
  return isRecord(capabilities) && capabilities.type === "chat";
}

export function isPickerModel(model: unknown): boolean {
  if (!isLiveChatModel(model) || !isRecord(model)) {
    return false;
  }

  return model.model_picker_enabled !== false;
}

export function getReleaseDate(id: string, version: unknown, fallback = ""): string {
  if (typeof version === "string" && version.startsWith(`${id}-`)) {
    return version.slice(id.length + 1);
  }
  return typeof version === "string" ? version : fallback;
}

export function getHeader(headers: HeaderObject, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? headers.get(target) ?? undefined;
  }

  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => String(key).toLowerCase() === target);
    return found?.[1];
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return undefined;
}

export function getConversationMetadata(init: RequestInit | undefined): ConversationMetadata {
  try {
    const body = parseBody(init?.body);

    if (isRecord(body) && Array.isArray(body.messages)) {
      const messages = body.messages as ChatMessage[];
      const lastMessage = messages[messages.length - 1];
      const role = lastMessage?.role;
      return {
        isVision: messages.some(
          (message) =>
            Array.isArray(message?.content)
            && message.content.some((part) => part?.type === "image_url"),
        ),
        isAgent: role === "tool" || role === "assistant",
      };
    }

    if (isRecord(body) && Array.isArray(body.input)) {
      const inputList = body.input as ResponsesInputItem[];
      const lastInput = inputList[inputList.length - 1];
      const isAssistant = lastInput?.role === "assistant";
      const hasAgentType = lastInput?.type
        ? (RESPONSES_API_ALTERNATE_INPUT_TYPES as readonly string[]).includes(lastInput.type)
        : false;

      return {
        isVision:
          Array.isArray(lastInput?.content)
          && lastInput.content.some((part) => part?.type === "input_image"),
        isAgent: isAssistant || hasAgentType,
      };
    }
  } catch {
    // intentional: return safe defaults on any parse/inspection error
  }

  return {
    isVision: false,
    isAgent: false,
  };
}

export function getRequestedRawModelId(init: RequestInit | undefined): string | undefined {
  try {
    const body = parseBody(init?.body);
    if (!isRecord(body) || typeof body.model !== "string") {
      return undefined;
    }

    return body.model.trim() ? body.model.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function applyBaseURLToRequestInput(input: RequestInfo | URL, baseURL?: string | null) {
  if (!baseURL) {
    return input;
  }

  try {
    const original =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : typeof Request !== "undefined" && input instanceof Request
          ? new URL(input.url)
          : null;

    if (!original) {
      return input;
    }

    const nextBase = new URL(baseURL);
    const nextUrl = new URL(`${original.pathname}${original.search}${original.hash}`, nextBase);

    if (typeof Request !== "undefined" && input instanceof Request) {
      return new Request(nextUrl.toString(), input);
    }

    return nextUrl.toString();
  } catch {
    return input;
  }
}

export function isValidBaseURL(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function resolveClaudeThinkingBudget(model: { id?: string } | undefined, variant: unknown): number | undefined {
  if (!model?.id?.includes("claude")) return undefined;
  return variant === "thinking" ? 16000 : undefined;
}

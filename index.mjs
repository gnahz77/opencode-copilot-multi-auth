import { homedir } from "os";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
  existsSync,
} from "fs";
import { dirname } from "path";

const ACCOUNT_POOL_SCHEMA_VERSION = 1;
const ROUTING_ACCOUNT_KEY_HEADER = "x-opencode-copilot-account-key";
const ROUTING_SOURCE_HEADER = "x-opencode-copilot-route-source";
const INTERNAL_ROUTING_HEADERS = new Set([
  ROUTING_ACCOUNT_KEY_HEADER,
  ROUTING_SOURCE_HEADER,
]);

export function getPoolPath() {
  return `${homedir()}/.local/share/opencode/copilot-auth.json`;
}

function validatePoolSchema(pool, context) {
  if (
    !pool
    || typeof pool !== "object"
    || pool.version !== ACCOUNT_POOL_SCHEMA_VERSION
    || !Array.isArray(pool.accounts)
  ) {
    throw new Error(
      `[opencode-copilot-cli-auth] Invalid ${context}: expected { version: ${ACCOUNT_POOL_SCHEMA_VERSION}, accounts: [] } schema.`,
    );
  }

  return pool;
}

export function readPool() {
  const poolPath = getPoolPath();

  if (!existsSync(poolPath)) {
    const defaultPool = {
      version: ACCOUNT_POOL_SCHEMA_VERSION,
      accounts: [],
    };
    writePool(defaultPool);
    return defaultPool;
  }

  const raw = readFileSync(poolPath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[opencode-copilot-cli-auth] Malformed JSON in account pool file at ${poolPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validatePoolSchema(parsed, `account pool file at ${poolPath}`);
}

export function writePool(pool) {
  const validatedPool = validatePoolSchema(pool, "account pool payload");
  const poolPath = getPoolPath();
  const dirPath = dirname(poolPath);
  const tmpPath = `${poolPath}.tmp`;

  mkdirSync(dirPath, { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(validatedPool, null, 2)}\n`, "utf8");
  renameSync(tmpPath, poolPath);
  chmodSync(poolPath, 0o600);
}

function normalizeHeaderObject(headers) {
  if (!headers) {
    return {};
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePriority(value) {
  return Number.isInteger(value) ? value : 0;
}

function normalizeDomain(urlOrDomain) {
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
  } catch { // intentional: fall back to regex-based normalization if URL parsing fails
    return value
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  }
}

function normalizeIdSource(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function preserveStringOrDefault(value, fallback) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return fallback;
}

function deriveDefaultAccountId(accounts, key, identity) {
  const userIdText = String(identity.userId);
  const baseId = normalizeIdSource(identity.login || userIdText) || userIdText;
  const idTakenByDifferentKey = accounts.some(
    (account) => account?.id === baseId && account?.key !== key,
  );

  if (!idTakenByDifferentKey) {
    return baseId;
  }

  return `${baseId}-${userIdText.slice(-6)}`;
}

export function deriveAccountKey(deployment, userId) {
  return `${deployment}:${userId}`;
}

export async function lookupGitHubIdentity(accessToken, enterpriseUrl) {
  const deployment = enterpriseUrl ? normalizeDomain(enterpriseUrl) : "github.com";
  const apiDomain = deployment === "github.com" ? "api.github.com" : `api.${deployment}`;
  const identityUrl = `https://${apiDomain}/user`;

  const response = await fetch(identityUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `[opencode-copilot-cli-auth] Failed to lookup GitHub identity from ${identityUrl}: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  const userId = Number(payload?.id);
  if (!Number.isFinite(userId)) {
    throw new Error(
      "[opencode-copilot-cli-auth] Failed to lookup GitHub identity: response did not include a numeric user id.",
    );
  }

  return {
    login: typeof payload?.login === "string" ? payload.login : "",
    userId,
  };
}

export function upsertAccount(pool, accountData) {
  const validatedPool = validatePoolSchema(pool, "account pool payload");
  const now = new Date().toISOString();
  const {
    key,
    deployment,
    domain,
    identity,
    enterpriseUrl,
    baseUrl,
    auth,
    authResult,
  } = accountData ?? {};

  if (!key || typeof key !== "string") {
    throw new Error("[opencode-copilot-cli-auth] Cannot upsert account: missing key.");
  }

  const userId = Number(identity?.userId);
  if (!Number.isFinite(userId)) {
    throw new Error("[opencode-copilot-cli-auth] Cannot upsert account: missing numeric identity.userId.");
  }

  const login = typeof identity?.login === "string" ? identity.login : "";
  const normalizedDeployment = normalizeDomain(deployment || domain || enterpriseUrl || "github.com");
  const normalizedDomain = normalizeDomain(domain || normalizedDeployment);
  const normalizedEnterpriseUrl =
    normalizedDeployment === "github.com"
      ? null
      : normalizeDomain(enterpriseUrl || normalizedDeployment);
  const normalizedIdentity = {
    login,
    userId,
  };
  const defaultId = deriveDefaultAccountId(validatedPool.accounts, key, normalizedIdentity);
  const defaultName = login || String(userId);
  const mergedAuth = auth ?? authResult ?? {};
  const nextBaseUrl = baseUrl ?? authResult?.baseUrl ?? null;

  const existingIndex = validatedPool.accounts.findIndex((account) => account?.key === key);
  if (existingIndex === -1) {
    return {
      ...validatedPool,
      accounts: [
        ...validatedPool.accounts,
        {
          key,
          id: defaultId,
          name: defaultName,
          enabled: true,
          priority: 0,
          deployment: normalizedDeployment,
          domain: normalizedDomain,
          identity: normalizedIdentity,
          enterpriseUrl: normalizedEnterpriseUrl,
          baseUrl: nextBaseUrl,
          allowlist: [],
          blocklist: [],
          auth: mergedAuth,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
  }

  const existing = validatedPool.accounts[existingIndex];
  const updatedAccount = {
    ...existing,
    key,
    deployment: normalizedDeployment,
    domain: normalizedDomain,
    identity: normalizedIdentity,
    enterpriseUrl: normalizedEnterpriseUrl,
    auth: mergedAuth,
    baseUrl: nextBaseUrl ?? existing.baseUrl ?? null,
    id: preserveStringOrDefault(existing.id, defaultId),
    name: preserveStringOrDefault(existing.name, defaultName),
    enabled: typeof existing.enabled === "boolean" ? existing.enabled : true,
    priority: Number.isFinite(existing.priority) ? existing.priority : 0,
    allowlist: Array.isArray(existing.allowlist) ? existing.allowlist : [],
    blocklist: Array.isArray(existing.blocklist) ? existing.blocklist : [],
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
  };

  const nextAccounts = [...validatedPool.accounts];
  nextAccounts[existingIndex] = updatedAccount;

  return {
    ...validatedPool,
    accounts: nextAccounts,
  };
}

export function resolveWinnerAccount(rawModelId, pool) {
  const candidates = (Array.isArray(pool?.accounts) ? pool.accounts : [])
    .filter((account) => account?.enabled !== false)
    .filter((account) => {
      const allowlist = normalizeList(account?.allowlist);
      return allowlist.length === 0 || allowlist.includes(rawModelId);
    })
    .filter((account) => !normalizeList(account?.blocklist).includes(rawModelId))
    .sort((left, right) => {
      const priorityDelta = normalizePriority(right?.priority) - normalizePriority(left?.priority);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return String(left?.key ?? "").localeCompare(String(right?.key ?? ""));
    });

  return candidates[0] ?? null;
}

export function injectRoutingHeaders(headers, accountKey) {
  return {
    ...normalizeHeaderObject(headers),
    [ROUTING_ACCOUNT_KEY_HEADER]: accountKey,
    [ROUTING_SOURCE_HEADER]: "model-resolution",
  };
}

export function stripRoutingHeaders(headers) {
  return Object.fromEntries(
    Object.entries(normalizeHeaderObject(headers)).filter(
      ([key]) => !INTERNAL_ROUTING_HEADERS.has(key.toLowerCase()),
    ),
  );
}

/**
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export async function CopilotAuthPlugin(input = {}) {
  const CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm";
  const API_VERSION = "2025-05-01";
  const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
  const OAUTH_SCOPES = "read:user read:org repo gist";
  const RESPONSES_API_ALTERNATE_INPUT_TYPES = [
    "file_search_call",
    "computer_call",
    "computer_call_output",
    "web_search_call",
    "function_call",
    "function_call_output",
    "image_generation_call",
    "code_interpreter_call",
    "local_shell_call",
    "local_shell_call_output",
    "mcp_list_tools",
    "mcp_approval_request",
    "mcp_approval_response",
    "mcp_call",
    "reasoning",
  ];

  function getUrls(domain) {
    const apiDomain = domain === "github.com" ? "api.github.com" : `api.${domain}`;
    return {
      DEVICE_CODE_URL: `https://${domain}/login/device/code`,
      ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
      COPILOT_ENTITLEMENT_URL: `https://${apiDomain}/copilot_internal/user`,
    };
  }

  async function fetchEntitlement(info) {
    const domain = info.enterpriseUrl ? normalizeDomain(info.enterpriseUrl) : "github.com";
    const urls = getUrls(domain);

    const response = await fetch(urls.COPILOT_ENTITLEMENT_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${info.refresh}`,
        "User-Agent": "GithubCopilot/1.155.0",
      },
    });

    if (!response.ok) {
      throw new Error(`[opencode-copilot-cli-auth] Entitlement fetch failed: ${response.status}`);
    }

    return response.json();
  }

  async function getBaseURL(info) {
    if (info.baseUrl) return info.baseUrl;
    const entitlement = await fetchEntitlement(info);
    return entitlement?.endpoints?.api;
  }

  async function fetchModels(info, baseURL) {
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${info.refresh}`,
        "Copilot-Integration-Id": "copilot-developer-cli",
        "Openai-Intent": "model-access",
        "User-Agent": "opencode-copilot-cli-auth/0.0.16",
        "X-GitHub-Api-Version": API_VERSION,
        "X-Interaction-Type": "model-access",
        "X-Request-Id": crypto.randomUUID(),
      },
    });

    if (!response.ok) {
      throw new Error(`[opencode-copilot-cli-auth] Model fetch failed: ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data?.data) ? data.data : [];
  }

  function zeroCost() {
    return {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    };
  }

  function isLiveChatModel(model) {
    return model?.capabilities?.type === "chat";
  }

  function isPickerModel(model) {
    return isLiveChatModel(model) && model?.model_picker_enabled !== false;
  }

  function getReleaseDate(id, version, fallback = "") {
    if (typeof version === "string" && version.startsWith(`${id}-`)) {
      return version.slice(id.length + 1);
    }
    return version || fallback;
  }

  function createProviderModel(existing, live, baseURL) {
    const limits = live.capabilities?.limits ?? {};
    const supports = live.capabilities?.supports ?? {};
    const vision = !!supports.vision || !!limits.vision;
    const reasoning =
      existing?.capabilities?.reasoning
      ?? (
        !!supports.adaptive_thinking
        || typeof supports.max_thinking_budget === "number"
        || Array.isArray(supports.reasoning_effort)
      );

    return {
      ...structuredClone(existing ?? {}),
      id: live.id,
      api: {
        ...(existing?.api ?? {}),
        id: live.id,
        url: baseURL,
        npm: "@ai-sdk/github-copilot",
      },
      name: live.name ?? existing?.name ?? live.id,
      family: live.capabilities?.family ?? existing?.family ?? "",
      cost: zeroCost(),
      limit: {
        context:
          limits.max_context_window_tokens
          ?? existing?.limit?.context
          ?? 0,
        input:
          limits.max_prompt_tokens
          ?? existing?.limit?.input
          ?? limits.max_context_window_tokens,
        output:
          limits.max_output_tokens
          ?? limits.max_non_streaming_output_tokens
          ?? existing?.limit?.output
          ?? 0,
      },
      capabilities: {
        temperature: existing?.capabilities?.temperature ?? true,
        reasoning,
        attachment: existing?.capabilities?.attachment ?? vision,
        toolcall: !!supports.tool_calls,
        input: {
          text: existing?.capabilities?.input?.text ?? true,
          audio: existing?.capabilities?.input?.audio ?? false,
          image: existing?.capabilities?.input?.image ?? vision,
          video: existing?.capabilities?.input?.video ?? false,
          pdf: existing?.capabilities?.input?.pdf ?? false,
        },
        output: {
          text: existing?.capabilities?.output?.text ?? true,
          audio: existing?.capabilities?.output?.audio ?? false,
          image: existing?.capabilities?.output?.image ?? false,
          video: existing?.capabilities?.output?.video ?? false,
          pdf: existing?.capabilities?.output?.pdf ?? false,
        },
        interleaved: existing?.capabilities?.interleaved ?? false,
      },
      options: existing?.options ?? {},
      headers: existing?.headers ?? {},
      release_date: getReleaseDate(live.id, live.version, existing?.release_date ?? ""),
      variants: existing?.variants ?? {},
      status: "active",
    };
  }

  function buildProviderModels(existingModels, liveModels, baseURL) {
    const existingById = new Map(
      Object.values(existingModels ?? {}).map((model) => [model?.api?.id ?? model?.id, model]),
    );

    return Object.fromEntries(
      liveModels
        .filter(isPickerModel)
        .map((model) => [
          model.id,
          createProviderModel(existingById.get(model.id), model, baseURL),
        ]),
    );
  }

  function normalizeExistingModels(existingModels, baseURL) {
    return Object.fromEntries(
      Object.entries(existingModels ?? {}).map(([id, model]) => [
        id,
        {
          ...structuredClone(model),
          cost: zeroCost(),
          api: {
            ...model.api,
            url: baseURL ?? model.api?.url,
            npm: "@ai-sdk/github-copilot",
          },
        },
      ]),
    );
  }

  async function resolveProviderModels(existingModels, auth) {
    const baseURL = auth ? await getBaseURL(auth) : undefined;
    if (!auth || auth.type !== "oauth" || !baseURL) {
      return normalizeExistingModels(existingModels, baseURL);
    }

    const liveModels = await fetchModels(auth, baseURL);
    return buildProviderModels(existingModels, liveModels, baseURL);
  }

  async function buildPoolBackedModels(existingModels, pool) {
    const enabledAccounts = (Array.isArray(pool?.accounts) ? pool.accounts : [])
      .filter((account) => account?.enabled !== false);

    if (enabledAccounts.length === 0) {
      return {};
    }

    const candidatesByModel = new Map();

    for (const account of enabledAccounts) {
      try {
        const baseURL = account.baseUrl ?? await getBaseURL(account.auth);
        const liveModels = await fetchModels(account.auth, baseURL);

        for (const liveModel of liveModels.filter(isPickerModel)) {
          const winner = resolveWinnerAccount(liveModel.id, pool);
          if (winner?.key === account.key) {
            candidatesByModel.set(liveModel.id, {
              account,
              liveModel,
              baseURL,
            });
          }
        }
      } catch (error) {
        console.warn(
          `[opencode-copilot-cli-auth] Skipping account ${account?.key ?? "unknown"} during model sync:`,
          error?.message ?? error,
        );
      }
    }

    const existingById = new Map(
      Object.values(existingModels ?? {}).map((model) => [model?.api?.id ?? model?.id, model]),
    );

    return Object.fromEntries(
      [...candidatesByModel.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([rawModelId, { liveModel, baseURL }]) => [
          rawModelId,
          createProviderModel(existingById.get(rawModelId), liveModel, baseURL),
        ]),
    );
  }

  function getHeader(headers, name) {
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

  function getConversationMetadata(init) {
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;

      if (body?.messages) {
        const lastMessage = body.messages[body.messages.length - 1];
        return {
          isVision: body.messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "image_url"),
          ),
          isAgent:
            lastMessage?.role &&
            ["tool", "assistant"].includes(lastMessage.role),
        };
      }

      if (body?.input) {
        const lastInput = body.input[body.input.length - 1];
        const isAssistant = lastInput?.role === "assistant";
        const hasAgentType = lastInput?.type
          ? RESPONSES_API_ALTERNATE_INPUT_TYPES.includes(lastInput.type)
          : false;

        return {
          isVision:
            Array.isArray(lastInput?.content) &&
            lastInput.content.some((part) => part.type === "input_image"),
          isAgent: isAssistant || hasAgentType,
        };
      }
    } catch {} // intentional: return safe defaults on any parse/inspection error

    return {
      isVision: false,
      isAgent: false,
    };
  }

  function getRequestedRawModelId(init) {
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    } catch { // intentional: return undefined on body parse error
      return undefined;
    }
  }

  function applyBaseURLToRequestInput(input, baseURL) {
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
    } catch { // intentional: return original input on URL rewrite error
      return input;
    }
  }

  function buildHeaders(init, info, isVision, isAgent) {
    const explicitInitiator = getHeader(init?.headers, "x-initiator");
    const headers = {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${info.refresh}`,
      "Copilot-Integration-Id": "copilot-developer-cli",
      "Openai-Intent": "conversation-agent",
      "User-Agent": "opencode-copilot-cli-auth/0.0.16",
      "X-GitHub-Api-Version": API_VERSION,
      "X-Initiator": explicitInitiator ?? (isAgent ? "agent" : "user"),
      "X-Interaction-Id": crypto.randomUUID(),
      "X-Interaction-Type": "conversation-agent",
      "X-Request-Id": crypto.randomUUID(),
    };

    if (isVision) {
      headers["Copilot-Vision-Request"] = "true";
    }

    delete headers["x-api-key"];
    delete headers["authorization"];
    delete headers["x-initiator"];

    return stripRoutingHeaders(headers);
  }

  function getSelectedAccountMissingError() {
    return new Error(
      "[opencode-copilot-cli-auth] Selected account is disabled or not found; re-login required",
    );
  }

  function getSelectedAccountExpiredError(accountKey) {
    return new Error(
      `[opencode-copilot-cli-auth] Account auth expired for ${accountKey}; re-login required`,
    );
  }

  function isValidBaseURL(value) {
    if (typeof value !== "string" || !value.trim()) {
      return false;
    }

    try {
      new URL(value);
      return true;
    } catch { // intentional: invalid URL means value is not a valid URL
      return false;
    }
  }

  function resolveSelectedPoolAccount(pool, accountKey, requestedRawModelId) {
    const accounts = Array.isArray(pool?.accounts) ? pool.accounts : [];

    if (accounts.length === 0) {
      return null;
    }

    let selectedAccount = null;

    if (accountKey) {
      const headerAccount = accounts.find((account) => account?.key === accountKey);
      if (!headerAccount || headerAccount.enabled === false) {
        throw getSelectedAccountMissingError();
      }
      selectedAccount = headerAccount;
    }

    if (requestedRawModelId) {
      const winner = resolveWinnerAccount(requestedRawModelId, pool);
      if (!winner) {
        throw new Error(
          `[opencode-copilot-cli-auth] No eligible account found for model ${requestedRawModelId}; re-login required`,
        );
      }

      if (selectedAccount && winner.key !== selectedAccount.key) {
        throw new Error(
          `[opencode-copilot-cli-auth] Selected account cannot serve model ${requestedRawModelId}; re-login required`,
        );
      }

      selectedAccount = winner;
    }

    if (!selectedAccount) {
      throw new Error("[opencode-copilot-cli-auth] No eligible account found for routed request; re-login required");
    }

    if (
      selectedAccount.auth?.type !== "oauth"
      || typeof selectedAccount.auth.refresh !== "string"
      || !selectedAccount.auth.refresh.trim()
    ) {
      throw getSelectedAccountExpiredError(selectedAccount.key ?? "unknown");
    }

    return selectedAccount;
  }

  async function refreshSelectedAccountBaseURL(accountKey) {
    const currentPool = readPool();
    const accountIndex = currentPool.accounts.findIndex((account) => account?.key === accountKey);
    const currentAccount = accountIndex >= 0 ? currentPool.accounts[accountIndex] : null;

    if (!currentAccount || currentAccount.enabled === false) {
      throw getSelectedAccountMissingError();
    }

    if (
      currentAccount.auth?.type !== "oauth"
      || typeof currentAccount.auth.refresh !== "string"
      || !currentAccount.auth.refresh.trim()
    ) {
      throw getSelectedAccountExpiredError(currentAccount.key ?? accountKey ?? "unknown");
    }

    let entitlement;
    try {
      entitlement = await fetchEntitlement({
        refresh: currentAccount.auth.refresh,
        enterpriseUrl: currentAccount.enterpriseUrl ?? null,
      });
    } catch { // intentional: entitlement fetch failure means account is expired/invalid; propagate as account error
      throw getSelectedAccountExpiredError(currentAccount.key);
    }

    const nextBaseURL = entitlement?.endpoints?.api;
    if (!isValidBaseURL(nextBaseURL)) {
      throw getSelectedAccountExpiredError(currentAccount.key);
    }

    const updatedPool = {
      ...currentPool,
      accounts: currentPool.accounts.map((account, index) =>
        index === accountIndex
          ? {
            ...account,
            baseUrl: nextBaseURL,
            updatedAt: new Date().toISOString(),
          }
          : account
      ),
    };

    writePool(updatedPool);
    return updatedPool.accounts[accountIndex];
  }

  async function fetchWithSelectedAccount(input, init, selectedAccount) {
    const { isVision, isAgent } = getConversationMetadata(init);

    const dispatch = async (account) => {
      const headers = buildHeaders(init, account.auth, isVision, isAgent);
      const requestInput = applyBaseURLToRequestInput(input, account.baseUrl);

      return fetch(requestInput, {
        ...init,
        headers,
      });
    };

    let activeAccount = selectedAccount;
    if (!isValidBaseURL(activeAccount.baseUrl)) {
      activeAccount = await refreshSelectedAccountBaseURL(activeAccount.key);
    }

    const response = await dispatch(activeAccount);
    if (![401, 403].includes(response.status)) {
      return response;
    }

    const refreshedAccount = await refreshSelectedAccountBaseURL(activeAccount.key);
    const retryResponse = await dispatch(refreshedAccount);
    if ([401, 403].includes(retryResponse.status)) {
      throw getSelectedAccountExpiredError(refreshedAccount.key);
    }

    return retryResponse;
  }

  function resolveClaudeThinkingBudget(model, variant) {
    if (!model?.id?.includes("claude")) return undefined;
    return variant === "thinking" ? 16000 : undefined;
  }

  return {
    provider: {
      id: "github-copilot",
      models: async (provider, ctx) => {
        try {
          const pool = readPool();
          if (pool.accounts.length > 0) {
            return await buildPoolBackedModels(provider.models, pool);
          }

          return await resolveProviderModels(provider.models, ctx.auth);
        } catch (error) {
          console.warn("[opencode-copilot-cli-auth] Failed to sync live Copilot models.", error?.message ?? error);
          return normalizeExistingModels(provider.models);
        }
      },
    },
    auth: {
      provider: "github-copilot",
      loader: async (getAuth) => {
        const info = await getAuth();
        let poolFirstEnabled;

        try {
          const currentPool = readPool();
          poolFirstEnabled = currentPool.accounts.find((account) => account?.enabled !== false);
          if (currentPool.accounts.length === 0 && info && info.type === "oauth") {
            // Best-effort migration bridge for legacy single-account auth.
            // We intentionally avoid identity lookup here because loader runs on hot paths,
            // and we do not have a stable userId without making a network request.
            // The next successful OAuth authorize callback performs canonical persistence.
          }
        } catch {} // intentional: pool read/parse errors fall back to legacy singleton auth

        const baseSource =
          poolFirstEnabled?.auth?.type === "oauth"
            ? poolFirstEnabled.auth
            : info && info.type === "oauth"
              ? info
              : null;
        if (!baseSource) return {};

        const baseURL = poolFirstEnabled?.baseUrl ?? await getBaseURL(baseSource);

        return {
          ...(baseURL && { baseURL }),
          apiKey: "",
          async fetch(input, init) {
            const pool = readPool();
            const accountKey = getHeader(init?.headers, ROUTING_ACCOUNT_KEY_HEADER);
            const requestedRawModelId = getRequestedRawModelId(init);

            if (pool.accounts.length > 0) {
              const selectedAccount = resolveSelectedPoolAccount(pool, accountKey, requestedRawModelId);
              if (selectedAccount?.auth?.type === "oauth") {
                return fetchWithSelectedAccount(input, init, selectedAccount);
              }
            }

            const auth = await getAuth();
            if (!auth || auth.type !== "oauth") {
              return fetch(input, init);
            }

            const { isVision, isAgent } = getConversationMetadata(init);
            const headers = buildHeaders(init, auth, isVision, isAgent);

            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot CLI",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com (Add)",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise (Add)",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "github.com or https://github.com (default: github.com)",
              condition: (inputs) => inputs.deploymentType === "enterprise",
              validate: (value) => {
                if (!value || !String(value).trim()) {
                  return undefined;
                }
                try {
                  const url = value.includes("://")
                    ? new URL(value)
                    : new URL(`https://${value}`);
                  if (!url.hostname) {
                    return "Please enter a valid URL or domain";
                  }
                  return undefined;
                } catch { // intentional: invalid URL input returns a user-facing validation error message
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)";
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com";

            let domain = "github.com";
            let actualProvider = "github-copilot";

            if (deploymentType === "enterprise") {
              domain = normalizeDomain(inputs.enterpriseUrl);
              actualProvider = "github-copilot-enterprise";
            }

            const urls = getUrls(domain);

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": "opencode-copilot-cli-auth/0.0.16",
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: OAUTH_SCOPES,
              }),
            });

            if (!deviceResponse.ok) {
              throw new Error("[opencode-copilot-cli-auth] Failed to initiate device authorization");
            }

            const deviceData = await deviceResponse.json();

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto",
              callback: async () => {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": "opencode-copilot-cli-auth/0.0.16",
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type:
                        "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  });

                  if (!response.ok) return { type: "failed" };

                  const data = await response.json();

                  if (data.access_token) {
                    const entitlement = await fetchEntitlement({
                      refresh: data.access_token,
                      enterpriseUrl:
                        actualProvider === "github-copilot-enterprise"
                          ? domain
                          : undefined,
                    });

                    const result = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                      baseUrl: entitlement?.endpoints?.api,
                    };

                    if (actualProvider === "github-copilot-enterprise") {
                      result.provider = "github-copilot-enterprise";
                      result.enterpriseUrl = domain;
                    }

                    try {
                      const identity = await lookupGitHubIdentity(
                        data.access_token,
                        actualProvider === "github-copilot-enterprise" ? domain : undefined,
                      );
                      const deployment = actualProvider === "github-copilot-enterprise" ? domain : "github.com";
                      const key = deriveAccountKey(deployment, identity.userId);
                      const pool = readPool();
                      const updatedPool = upsertAccount(pool, {
                        key,
                        deployment,
                        domain: deployment,
                        identity,
                        enterpriseUrl: actualProvider === "github-copilot-enterprise" ? domain : null,
                        baseUrl: result.baseUrl,
                        auth: {
                          type: "oauth",
                          refresh: data.access_token,
                          access: data.access_token,
                          expires: 0,
                          baseUrl: result.baseUrl ?? null,
                          ...(result.provider && { provider: result.provider }),
                          ...(result.enterpriseUrl && { enterpriseUrl: result.enterpriseUrl }),
                        },
                      });
                      writePool(updatedPool);
                    } catch (persistError) {
                      console.warn(
                        "[opencode-copilot-cli-auth] Failed to persist account to pool:",
                        persistError?.message ?? persistError,
                      );
                      // Non-fatal: continue with the login flow.
                    }

                    return result;
                  }

                  if (data.error === "authorization_pending") {
                    await new Promise((resolve) =>
                      setTimeout(
                        resolve,
                        deviceData.interval * 1000
                          + OAUTH_POLLING_SAFETY_MARGIN_MS,
                      ),
                    );
                    continue;
                  }

                  if (data.error === "slow_down") {
                    const nextInterval =
                      (typeof data.interval === "number" && data.interval > 0 ?
                        data.interval
                      : deviceData.interval + 5) * 1000;
                    await new Promise((resolve) =>
                      setTimeout(
                        resolve,
                        nextInterval + OAUTH_POLLING_SAFETY_MARGIN_MS,
                      ),
                    );
                    continue;
                  }

                  if (data.error) return { type: "failed" };

                  await new Promise((resolve) =>
                    setTimeout(
                      resolve,
                      deviceData.interval * 1000
                        + OAUTH_POLLING_SAFETY_MARGIN_MS,
                    ),
                  );
                }
              },
            };
          },
        },
      ],
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "github-copilot") return;
      if (input.model.api?.npm !== "@ai-sdk/github-copilot") return;
      if (!input.model.id.includes("claude")) return;

      const thinkingBudget = resolveClaudeThinkingBudget(input.model, input.message.variant);
      if (thinkingBudget === undefined) return;

      output.options.thinking_budget = thinkingBudget;
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return;

      const sdk = input.client;
      if (sdk?.session?.message && sdk?.session?.get) {
        const parts = await sdk.session
          .message({
            path: {
              id: incoming.message.sessionID,
              messageID: incoming.message.id,
            },
            query: {
              directory: input.directory,
            },
            throwOnError: true,
          })
          .catch(() => undefined);

        if (parts?.data?.parts?.some((part) => part.type === "compaction")) {
          output.headers["x-initiator"] = "agent";
        } else {
          const session = await sdk.session
            .get({
              path: {
                id: incoming.sessionID,
              },
              query: {
                directory: input.directory,
              },
              throwOnError: true,
            })
            .catch(() => undefined);

          if (session?.data?.parentID) {
            output.headers["x-initiator"] = "agent";
          }
        }
      }

      try {
        const pool = readPool();
        if (pool.accounts.length > 0) {
          const winner = resolveWinnerAccount(incoming.model.id, pool);
          if (winner) {
            output.headers[ROUTING_ACCOUNT_KEY_HEADER] = winner.key;
            output.headers[ROUTING_SOURCE_HEADER] = "model-resolution";
          }
        }
      } catch {} // intentional: routing header injection is best-effort; missing header falls back to request-time model resolution
    },
  };
}

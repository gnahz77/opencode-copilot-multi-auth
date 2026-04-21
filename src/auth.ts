import { API_VERSION } from "./constants.js";
import { getSelectedAccountExpiredError, getSelectedAccountMissingError } from "./errors.js";
import { readPool, resolveWinnerAccount, writePool } from "./pool.js";
import { stripRoutingHeaders } from "./routing.js";
import type { AccountPool, AuthInput, HeaderObject, PoolAccount } from "./types.js";
import {
  applyBaseURLToRequestInput,
  getConversationMetadata,
  isValidBaseURL,
  normalizeDomain,
  normalizeHeaderObject,
} from "./utils.js";

export function getUrls(domain: string) {
  const apiDomain = domain === "github.com" ? "api.github.com" : `api.${domain}`;
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
    COPILOT_ENTITLEMENT_URL: `https://${apiDomain}/copilot_internal/user`,
  };
}

export async function lookupGitHubIdentity(accessToken: string, enterpriseUrl?: string) {
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

export async function fetchEntitlement(info: AuthInput) {
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

export async function getBaseURL(info: AuthInput) {
  if (info.baseUrl) return info.baseUrl;
  const entitlement = await fetchEntitlement(info);
  return entitlement?.endpoints?.api;
}

function getHeader(headers: HeaderObject, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? headers.get(target) ?? undefined;
  }

  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => String(key).toLowerCase() === target);
    return typeof found?.[1] === "string" ? found[1] : undefined;
  }

  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return undefined;
}

export function buildHeaders(init: RequestInit | undefined, info: AuthInput, isVision: boolean, isAgent: boolean) {
  const explicitInitiator = getHeader(init?.headers, "x-initiator");
  const headers: Record<string, string> = {
    ...normalizeHeaderObject(init?.headers),
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
  delete headers.authorization;
  delete headers["x-initiator"];

  return stripRoutingHeaders(headers);
}

export function resolveSelectedPoolAccount(pool: AccountPool, accountKey?: string, requestedRawModelId?: string) {
  const accounts = Array.isArray(pool?.accounts) ? pool.accounts : [];

  if (accounts.length === 0) {
    return null;
  }

  let selectedAccount: PoolAccount | null = null;

  if (accountKey) {
    const headerAccount = accounts.find((account: PoolAccount) => account?.key === accountKey);
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

export async function refreshSelectedAccountBaseURL(accountKey: string) {
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
  } catch {
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

export async function fetchWithSelectedAccount(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  selectedAccount: PoolAccount,
) {
  const { isVision, isAgent } = getConversationMetadata(init);

  const dispatch = async (account: PoolAccount) => {
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

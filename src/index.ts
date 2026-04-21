import type { Plugin } from "@opencode-ai/plugin";
import {
  CLIENT_ID,
  OAUTH_POLLING_SAFETY_MARGIN_MS,
  OAUTH_SCOPES,
  ROUTING_ACCOUNT_KEY_HEADER,
  ROUTING_SOURCE_HEADER,
} from "./constants.js";
import {
  buildHeaders,
  fetchEntitlement,
  fetchWithSelectedAccount,
  getBaseURL,
  getCopilotToken,
  getUrls,
  lookupGitHubIdentity,
  resolveSelectedPoolAccount,
} from "./auth.js";
import { buildPoolBackedModels, normalizeExistingModels, resolveProviderModels } from "./models.js";
import {
  deriveAccountKey,
  getPoolPath,
  readPool,
  resolveWinnerAccount,
  upsertAccount,
  writePool,
} from "./pool.js";
import { injectRoutingHeaders, stripRoutingHeaders } from "./routing.js";
import {
  getHeader,
  getConversationMetadata,
  getRequestedRawModelId,
  normalizeDomain,
  resolveClaudeThinkingBudget,
} from "./utils.js";
import type { PoolAccount } from "./types.js";

export { getPoolPath, readPool, writePool, deriveAccountKey, lookupGitHubIdentity, upsertAccount, resolveWinnerAccount };
export { injectRoutingHeaders, stripRoutingHeaders };

export const CopilotAuthPlugin: Plugin = async (input) => {
  return {
    provider: {
      id: "github-copilot",
      models: async (provider, ctx) => {
        try {
          const pool = readPool();
          if (pool.accounts.length > 0) {
            return await buildPoolBackedModels(provider.models, pool);
          }

          const oauthAuth = ctx.auth && ctx.auth.type === "oauth" ? ctx.auth : undefined;
          return await resolveProviderModels(provider.models, oauthAuth);
        } catch (error) {
          console.warn(
            "[opencode-copilot-cli-auth] Failed to sync live Copilot models.",
            error instanceof Error ? error.message : String(error),
          );
          return normalizeExistingModels(provider.models);
        }
      },
    },
    auth: {
      provider: "github-copilot",
      loader: async (getAuth) => {
        const info = await getAuth();
        let poolFirstEnabled: PoolAccount | null = null;

        try {
          const currentPool = readPool();
          poolFirstEnabled = currentPool.accounts.find((account) => account?.enabled !== false) ?? null;
          if (currentPool.accounts.length === 0 && info && info.type === "oauth") {
            // Best-effort migration bridge for legacy single-account auth.
            // We intentionally avoid identity lookup here because loader runs on hot paths,
            // and we do not have a stable userId without making a network request.
            // The next successful OAuth authorize callback performs canonical persistence.
          }
        } catch {
          // intentional: pool read/parse errors fall back to legacy singleton auth
        }

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
          async fetch(inputRequest: RequestInfo | URL, init?: RequestInit) {
            const pool = readPool();
            const accountKey = getHeader(init?.headers, ROUTING_ACCOUNT_KEY_HEADER);
            const requestedRawModelId = getRequestedRawModelId(init);

            if (pool.accounts.length > 0) {
              const selectedAccount = resolveSelectedPoolAccount(pool, accountKey, requestedRawModelId);
              if (selectedAccount?.auth?.type === "oauth") {
                return fetchWithSelectedAccount(inputRequest, init, selectedAccount);
              }
            }

            const auth = await getAuth();
            if (!auth || auth.type !== "oauth") {
              return fetch(inputRequest, init);
            }

            const { isVision, isAgent } = getConversationMetadata(init);
            const copilotToken = await getCopilotToken(auth);
            const headers = buildHeaders(init, copilotToken, isVision, isAgent);
            return fetch(inputRequest, {
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
                } catch {
                  return "Please enter a valid URL";
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
              method: "auto" as const,
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

                  if (!response.ok) return { type: "failed" as const };

                  const data = await response.json();

                  if (data.access_token) {
                    const entitlement = await fetchEntitlement({
                      refresh: data.access_token,
                      enterpriseUrl:
                        actualProvider === "github-copilot-enterprise"
                          ? domain
                          : undefined,
                    });

                    const result: {
                      type: "success";
                      refresh: string;
                      access: string;
                      expires: number;
                      baseUrl?: string;
                      provider?: string;
                      enterpriseUrl?: string;
                    } = {
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
                        baseUrl: result.baseUrl ?? null,
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
                        persistError instanceof Error ? persistError.message : String(persistError),
                      );
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
                      (typeof data.interval === "number" && data.interval > 0
                        ? data.interval
                        : deviceData.interval + 5) * 1000;
                    await new Promise((resolve) =>
                      setTimeout(
                        resolve,
                        nextInterval + OAUTH_POLLING_SAFETY_MARGIN_MS,
                      ),
                    );
                    continue;
                  }

                  if (data.error) return { type: "failed" as const };

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

      const messageWithVariant = input.message as unknown as { variant?: unknown };
      const thinkingBudget = resolveClaudeThinkingBudget(input.model, messageWithVariant.variant);
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
      } catch {
        // intentional: routing header injection is best-effort; missing header falls back to request-time model resolution
      }
    },
  };
};

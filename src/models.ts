import type { Model as SDKModel } from "@opencode-ai/sdk/v2";
import { getBaseURL, getCopilotToken } from "./auth.js";
import { API_VERSION, VSCODE_HEADERS } from "./constants.js";
import { resolveWinnerAccount } from "./pool.js";
import type { AccountPool, AuthInput, LiveModel, PoolAccount } from "./types.js";
import { getReleaseDate, isPickerModel, zeroCost } from "./utils.js";

export async function fetchModels(info: AuthInput, baseURL: string): Promise<LiveModel[]> {
  const copilotToken = await getCopilotToken(info);
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${copilotToken}`,
      ...VSCODE_HEADERS,
      "Openai-Intent": "model-access",
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

export function createProviderModel(existing: SDKModel | undefined, live: LiveModel, baseURL: string): SDKModel {
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
    providerID: existing?.providerID ?? "github-copilot",
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

export function buildProviderModels(
  existingModels: Record<string, SDKModel> | undefined,
  liveModels: LiveModel[],
  baseURL: string,
) {
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

export function normalizeExistingModels(existingModels: Record<string, SDKModel> | undefined, baseURL?: string) {
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

export async function resolveProviderModels(existingModels: Record<string, SDKModel> | undefined, auth: AuthInput | null | undefined) {
  const baseURL = auth ? await getBaseURL(auth) : undefined;
  if (!auth || auth.type !== "oauth" || !baseURL) {
    return normalizeExistingModels(existingModels, baseURL);
  }

  const liveModels = await fetchModels(auth, baseURL);
  return buildProviderModels(existingModels, liveModels, baseURL);
}

export async function buildPoolBackedModels(existingModels: Record<string, SDKModel> | undefined, pool: AccountPool) {
  const enabledAccounts = (Array.isArray(pool?.accounts) ? pool.accounts : [])
    .filter((account) => account?.enabled !== false);

  if (enabledAccounts.length === 0) {
    return normalizeExistingModels(existingModels);
  }

  const candidatesByModel = new Map<string, { account: PoolAccount; liveModel: LiveModel; baseURL: string }>();

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
    } catch (error: unknown) {
      console.warn(
        `[opencode-copilot-cli-auth] Skipping account ${account?.key ?? "unknown"} during model sync:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const existingById = new Map(
    Object.values(existingModels ?? {}).map((model) => [model?.api?.id ?? model?.id, model]),
  );

  if (candidatesByModel.size === 0) {
    return normalizeExistingModels(existingModels);
  }

  return Object.fromEntries(
    [...candidatesByModel.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rawModelId, { liveModel, baseURL }]) => [
        rawModelId,
        createProviderModel(existingById.get(rawModelId), liveModel, baseURL),
      ]),
  );
}

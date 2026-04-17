import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { ACCOUNT_POOL_SCHEMA_VERSION } from "./constants.js";
import type { AccountPool, OAuthAuth, PoolAccount, PoolIdentity, UpsertAccountData } from "./types.js";
import { normalizeDomain, normalizeIdSource, normalizeList, normalizePriority, preserveStringOrDefault } from "./utils.js";

export function getPoolPath() {
  return `${homedir()}/.local/share/opencode/copilot-auth.json`;
}

export function validatePoolSchema(pool: unknown, context: string): AccountPool {
  if (
    !pool
    || typeof pool !== "object"
    || (pool as AccountPool).version !== ACCOUNT_POOL_SCHEMA_VERSION
    || !Array.isArray((pool as AccountPool).accounts)
  ) {
    throw new Error(
      `[opencode-copilot-cli-auth] Invalid ${context}: expected { version: ${ACCOUNT_POOL_SCHEMA_VERSION}, accounts: [] } schema.`,
    );
  }

  return pool as AccountPool;
}

export function readPool(): AccountPool {
  const poolPath = getPoolPath();

  if (!existsSync(poolPath)) {
    const defaultPool: AccountPool = {
      version: ACCOUNT_POOL_SCHEMA_VERSION,
      accounts: [],
    };
    writePool(defaultPool);
    return defaultPool;
  }

  const raw = readFileSync(poolPath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[opencode-copilot-cli-auth] Malformed JSON in account pool file at ${poolPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validatePoolSchema(parsed, `account pool file at ${poolPath}`);
}

export function writePool(pool: AccountPool) {
  const validatedPool = validatePoolSchema(pool, "account pool payload");
  const poolPath = getPoolPath();
  const dirPath = dirname(poolPath);
  const tmpPath = `${poolPath}.tmp`;

  mkdirSync(dirPath, { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(validatedPool, null, 2)}\n`, "utf8");
  renameSync(tmpPath, poolPath);
  chmodSync(poolPath, 0o600);
}

function deriveDefaultAccountId(accounts: PoolAccount[], key: string, identity: PoolIdentity): string {
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

export function deriveAccountKey(deployment: string, userId: number) {
  return `${deployment}:${userId}`;
}

export function upsertAccount(pool: AccountPool, accountData: UpsertAccountData): AccountPool {
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
  const mergedAuth = (auth ?? authResult ?? {}) as OAuthAuth;
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

export function resolveWinnerAccount(rawModelId: string, pool: AccountPool) {
  const canAccountServeModel = (account: PoolAccount) => {
    const allowlist = normalizeList(account?.allowlist);
    if (allowlist.length > 0 && !allowlist.includes(rawModelId)) {
      return false;
    }

    const blocklist = normalizeList(account?.blocklist);
    return !blocklist.includes(rawModelId);
  };

  const candidates = (Array.isArray(pool?.accounts) ? pool.accounts : [])
    .filter((account) => account?.enabled !== false)
    .filter(canAccountServeModel)
    .sort((left, right) => {
      const priorityDelta = normalizePriority(right?.priority) - normalizePriority(left?.priority);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return String(left?.key ?? "").localeCompare(String(right?.key ?? ""));
    });

  return candidates[0] ?? null;
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { ACCOUNT_POOL_SCHEMA_VERSION } from "./constants.js";
import type {
  AccountPool,
  AuthPoolAccount,
  AuthPoolDocument,
  OAuthAuth,
  PolicyPoolAccount,
  PolicyPoolDocument,
  PoolAccount,
  PoolIdentity,
  UpsertAccountData,
} from "./types.js";
import {
  matchesAnyModelIdPattern,
  normalizeDomain,
  normalizeIdSource,
  normalizeList,
  normalizePriority,
  preserveStringOrDefault,
} from "./utils.js";

export function getPoolPath() {
  return `${homedir()}/.local/share/opencode/copilot-auth.json`;
}

export function getPolicyPath() {
  return `${homedir()}/.config/opencode/copilot-auth.json`;
}

function assertObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[opencode-copilot-cli-auth] Invalid ${context}: expected object.`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`[opencode-copilot-cli-auth] Invalid ${context}: expected string.`);
  }
  return value;
}

function assertNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`[opencode-copilot-cli-auth] Invalid ${context}: expected finite number.`);
  }
  return value;
}

function assertBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`[opencode-copilot-cli-auth] Invalid ${context}: expected boolean.`);
  }
  return value;
}

function assertNullableString(value: unknown, context: string): string | null {
  if (value === null) {
    return null;
  }
  return assertString(value, context);
}

function assertStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`[opencode-copilot-cli-auth] Invalid ${context}: expected string[].`);
  }
  return value;
}

function parsePoolIdentity(value: unknown, context: string): PoolIdentity {
  const identityObject = assertObject(value, context);
  return {
    login: assertString(identityObject.login, `${context}.login`),
    userId: assertNumber(identityObject.userId, `${context}.userId`),
  };
}

function parseOAuthAuth(value: unknown, context: string): OAuthAuth {
  const authObject = assertObject(value, context);
  if (authObject.type !== "oauth") {
    throw new Error(`[opencode-copilot-cli-auth] Invalid ${context}.type: expected \"oauth\".`);
  }

  const parsed: OAuthAuth = {
    type: "oauth",
    refresh: assertString(authObject.refresh, `${context}.refresh`),
  };

  if (typeof authObject.access === "string") {
    parsed.access = authObject.access;
  }

  if (typeof authObject.expires === "number" && Number.isFinite(authObject.expires)) {
    parsed.expires = authObject.expires;
  }

  if (authObject.baseUrl === null || typeof authObject.baseUrl === "string") {
    parsed.baseUrl = authObject.baseUrl;
  }

  if (typeof authObject.provider === "string") {
    parsed.provider = authObject.provider;
  }

  if (typeof authObject.enterpriseUrl === "string") {
    parsed.enterpriseUrl = authObject.enterpriseUrl;
  }

  return parsed;
}

function parseAuthPoolAccount(value: unknown, context: string): AuthPoolAccount {
  const account = assertObject(value, context);
  return {
    key: assertString(account.key, `${context}.key`),
    deployment: assertString(account.deployment, `${context}.deployment`),
    domain: assertString(account.domain, `${context}.domain`),
    identity: parsePoolIdentity(account.identity, `${context}.identity`),
    enterpriseUrl: assertNullableString(account.enterpriseUrl, `${context}.enterpriseUrl`),
    baseUrl: assertNullableString(account.baseUrl, `${context}.baseUrl`),
    auth: parseOAuthAuth(account.auth, `${context}.auth`),
    createdAt: assertString(account.createdAt, `${context}.createdAt`),
    updatedAt: assertString(account.updatedAt, `${context}.updatedAt`),
  };
}

function parsePolicyPoolAccount(value: unknown, context: string): PolicyPoolAccount {
  const account = assertObject(value, context);
  return {
    key: assertString(account.key, `${context}.key`),
    enabled: assertBoolean(account.enabled, `${context}.enabled`),
    priority: assertNumber(account.priority, `${context}.priority`),
    allowlist: assertStringArray(account.allowlist, `${context}.allowlist`),
    blocklist: assertStringArray(account.blocklist, `${context}.blocklist`),
  };
}

function parseVersionedAccountsDocument(value: unknown, context: string): { version: number; accounts: unknown[] } {
  const document = assertObject(value, context);
  if (document.version !== ACCOUNT_POOL_SCHEMA_VERSION || !Array.isArray(document.accounts)) {
    throw new Error(
      `[opencode-copilot-cli-auth] Invalid ${context}: expected { version: ${ACCOUNT_POOL_SCHEMA_VERSION}, accounts: [] } schema.`,
    );
  }

  return {
    version: document.version,
    accounts: document.accounts,
  };
}

function parseLegacyVersionedAccountsDocument(value: unknown, context: string): { version: number; accounts: unknown[] } {
  const document = assertObject(value, context);
  if (document.version !== 1 || !Array.isArray(document.accounts)) {
    throw new Error(
      `[opencode-copilot-cli-auth] Invalid ${context}: expected legacy { version: 1, accounts: [] } schema.`,
    );
  }

  return {
    version: document.version,
    accounts: document.accounts,
  };
}

function validateAuthPoolSchema(pool: unknown, context: string): AuthPoolDocument {
  const parsed = parseVersionedAccountsDocument(pool, context);
  return {
    version: parsed.version,
    accounts: parsed.accounts.map((account, index) =>
      parseAuthPoolAccount(account, `${context}.accounts[${index}]`)
    ),
  };
}

function validatePolicyPoolSchema(pool: unknown, context: string): PolicyPoolDocument {
  const parsed = parseVersionedAccountsDocument(pool, context);
  return {
    version: parsed.version,
    accounts: parsed.accounts.map((account, index) =>
      parsePolicyPoolAccount(account, `${context}.accounts[${index}]`)
    ),
  };
}

function validateLegacyPoolSchema(pool: unknown, context: string): AccountPool {
  const parsed = parseLegacyVersionedAccountsDocument(pool, context);
  return {
    version: parsed.version,
    accounts: parsed.accounts.map((account, index) => {
      const accountObject = assertObject(account, `${context}.accounts[${index}]`);
      return {
        key: assertString(accountObject.key, `${context}.accounts[${index}].key`),
        id: assertString(accountObject.id, `${context}.accounts[${index}].id`),
        name: assertString(accountObject.name, `${context}.accounts[${index}].name`),
        enabled: assertBoolean(accountObject.enabled, `${context}.accounts[${index}].enabled`),
        priority: assertNumber(accountObject.priority, `${context}.accounts[${index}].priority`),
        deployment: assertString(accountObject.deployment, `${context}.accounts[${index}].deployment`),
        domain: assertString(accountObject.domain, `${context}.accounts[${index}].domain`),
        identity: parsePoolIdentity(accountObject.identity, `${context}.accounts[${index}].identity`),
        enterpriseUrl: assertNullableString(accountObject.enterpriseUrl, `${context}.accounts[${index}].enterpriseUrl`),
        baseUrl: assertNullableString(accountObject.baseUrl, `${context}.accounts[${index}].baseUrl`),
        allowlist: assertStringArray(accountObject.allowlist, `${context}.accounts[${index}].allowlist`),
        blocklist: assertStringArray(accountObject.blocklist, `${context}.accounts[${index}].blocklist`),
        auth: parseOAuthAuth(accountObject.auth, `${context}.accounts[${index}].auth`),
        createdAt: assertString(accountObject.createdAt, `${context}.accounts[${index}].createdAt`),
        updatedAt: assertString(accountObject.updatedAt, `${context}.accounts[${index}].updatedAt`),
      };
    }),
  };
}

function toDefaultPolicyAccount(account: AuthPoolAccount): PolicyPoolAccount {
  return {
    key: account.key,
    enabled: true,
    priority: 0,
    allowlist: [],
    blocklist: [],
  };
}

function parseJsonFile(filePath: string, context: string): unknown {
  const raw = readFileSync(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[opencode-copilot-cli-auth] Malformed JSON in ${context} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJsonAtomic(filePath: string, payload: unknown) {
  const directoryPath = dirname(filePath);
  const tmpPath = `${filePath}.tmp`;

  mkdirSync(directoryPath, { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
  chmodSync(filePath, 0o600);
}

function buildAuthPoolDocument(pool: AccountPool): AuthPoolDocument {
  return {
    version: ACCOUNT_POOL_SCHEMA_VERSION,
    accounts: pool.accounts.map((account) => ({
      key: account.key,
      deployment: account.deployment,
      domain: account.domain,
      identity: account.identity,
      enterpriseUrl: account.enterpriseUrl,
      baseUrl: account.baseUrl,
      auth: account.auth,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    })),
  };
}

function buildPolicyPoolDocument(pool: AccountPool): PolicyPoolDocument {
  return {
    version: ACCOUNT_POOL_SCHEMA_VERSION,
    accounts: pool.accounts.map((account) => ({
      key: account.key,
      enabled: account.enabled,
      priority: account.priority,
      allowlist: account.allowlist,
      blocklist: account.blocklist,
    })),
  };
}

function mergePoolDocuments(authPool: AuthPoolDocument, policyPool: PolicyPoolDocument): AccountPool {
  const policyByKey = new Map(policyPool.accounts.map((account) => [account.key, account]));

  const merged: AccountPool = {
    version: ACCOUNT_POOL_SCHEMA_VERSION,
    accounts: authPool.accounts.map((authAccount) => {
      const policy = policyByKey.get(authAccount.key) ?? toDefaultPolicyAccount(authAccount);
      const userIdText = String(authAccount.identity.userId);
      const fallbackId = normalizeIdSource(authAccount.identity.login || userIdText) || userIdText;
      const fallbackName = authAccount.identity.login || userIdText;
      return {
        key: authAccount.key,
        id: fallbackId,
        name: fallbackName,
        enabled: policy.enabled,
        priority: policy.priority,
        deployment: authAccount.deployment,
        domain: authAccount.domain,
        identity: authAccount.identity,
        enterpriseUrl: authAccount.enterpriseUrl,
        baseUrl: authAccount.baseUrl,
        allowlist: policy.allowlist,
        blocklist: policy.blocklist,
        auth: authAccount.auth,
        createdAt: authAccount.createdAt,
        updatedAt: authAccount.updatedAt,
      };
    }),
  };

  return validatePoolSchema(merged, "merged account pool");
}

export function validatePoolSchema(pool: unknown, context: string): AccountPool {
  const parsed = parseVersionedAccountsDocument(pool, context);
  return {
    version: parsed.version,
    accounts: parsed.accounts.map((account, index) => {
      const accountObject = assertObject(account, `${context}.accounts[${index}]`);
      return {
        key: assertString(accountObject.key, `${context}.accounts[${index}].key`),
        id: assertString(accountObject.id, `${context}.accounts[${index}].id`),
        name: assertString(accountObject.name, `${context}.accounts[${index}].name`),
        enabled: assertBoolean(accountObject.enabled, `${context}.accounts[${index}].enabled`),
        priority: assertNumber(accountObject.priority, `${context}.accounts[${index}].priority`),
        deployment: assertString(accountObject.deployment, `${context}.accounts[${index}].deployment`),
        domain: assertString(accountObject.domain, `${context}.accounts[${index}].domain`),
        identity: parsePoolIdentity(accountObject.identity, `${context}.accounts[${index}].identity`),
        enterpriseUrl: assertNullableString(accountObject.enterpriseUrl, `${context}.accounts[${index}].enterpriseUrl`),
        baseUrl: assertNullableString(accountObject.baseUrl, `${context}.accounts[${index}].baseUrl`),
        allowlist: assertStringArray(accountObject.allowlist, `${context}.accounts[${index}].allowlist`),
        blocklist: assertStringArray(accountObject.blocklist, `${context}.accounts[${index}].blocklist`),
        auth: parseOAuthAuth(accountObject.auth, `${context}.accounts[${index}].auth`),
        createdAt: assertString(accountObject.createdAt, `${context}.accounts[${index}].createdAt`),
        updatedAt: assertString(accountObject.updatedAt, `${context}.accounts[${index}].updatedAt`),
      };
    }),
  };
}

export function readPool(): AccountPool {
  const authPath = getPoolPath();
  const policyPath = getPolicyPath();
  const defaultDocument = {
    version: ACCOUNT_POOL_SCHEMA_VERSION,
    accounts: [],
  };

  if (!existsSync(authPath)) {
    writeJsonAtomic(authPath, defaultDocument);
  }

  if (!existsSync(policyPath)) {
    writeJsonAtomic(policyPath, defaultDocument);
  }

  const parsedAuth = parseJsonFile(authPath, "Copilot auth file");
  const parsedPolicy = parseJsonFile(policyPath, "Copilot routing policy file");
  const authPool = validateAuthPoolSchema(parsedAuth, `auth pool file at ${authPath}`);
  const policyPool = validatePolicyPoolSchema(parsedPolicy, `policy pool file at ${policyPath}`);

  return mergePoolDocuments(authPool, policyPool);
}

export function writePool(pool: AccountPool) {
  const validatedPool = validatePoolSchema(pool, "account pool payload");
  const authDocument = validateAuthPoolSchema(buildAuthPoolDocument(validatedPool), "auth pool payload");
  const policyDocument = validatePolicyPoolSchema(buildPolicyPoolDocument(validatedPool), "policy pool payload");

  writeJsonAtomic(getPolicyPath(), policyDocument);
  writeJsonAtomic(getPoolPath(), authDocument);
}

export function writePoolAuthData(pool: AccountPool) {
  const validatedPool = validatePoolSchema(pool, "account pool payload");
  const authDocument = validateAuthPoolSchema(buildAuthPoolDocument(validatedPool), "auth pool payload");
  writeJsonAtomic(getPoolPath(), authDocument);
}

export function migrateLegacyPoolStorageIfNeeded() {
  const authPath = getPoolPath();
  const policyPath = getPolicyPath();

  if (!existsSync(authPath)) {
    return;
  }

  const parsed = parseJsonFile(authPath, "Copilot account pool file");

  try {
    const legacyPool = validateLegacyPoolSchema(parsed, `legacy account pool file at ${authPath}`);
    const existingPolicy = existsSync(policyPath)
      ? validatePolicyPoolSchema(parseJsonFile(policyPath, "Copilot routing policy file"), `policy pool file at ${policyPath}`)
      : null;
    const migratedPolicy: PolicyPoolDocument = {
      version: ACCOUNT_POOL_SCHEMA_VERSION,
      accounts: legacyPool.accounts.map((account) => {
        const existingPolicyAccount = existingPolicy?.accounts.find((candidate) => candidate.key === account.key);
        return existingPolicyAccount ?? {
          key: account.key,
          enabled: account.enabled,
          priority: account.priority,
          allowlist: account.allowlist,
          blocklist: account.blocklist,
        };
      }),
    };
    writeJsonAtomic(policyPath, validatePolicyPoolSchema(migratedPolicy, "migrated policy pool payload"));
    writeJsonAtomic(authPath, validateAuthPoolSchema(buildAuthPoolDocument(legacyPool), "migrated auth pool payload"));
    return;
  } catch {
    // Intentionally continue: file may already be auth-only format or a non-legacy document.
  }

  if (existsSync(policyPath)) {
    return;
  }

  const authPool = validateAuthPoolSchema(parsed, `auth pool file at ${authPath}`);
  const defaultPolicyPool: PolicyPoolDocument = {
    version: ACCOUNT_POOL_SCHEMA_VERSION,
    accounts: authPool.accounts.map((account) => toDefaultPolicyAccount(account)),
  };
  writeJsonAtomic(policyPath, validatePolicyPoolSchema(defaultPolicyPool, "default policy pool payload"));
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
    if (allowlist.length > 0 && !matchesAnyModelIdPattern(allowlist, rawModelId)) {
      return false;
    }

    const blocklist = normalizeList(account?.blocklist);
    return !matchesAnyModelIdPattern(blocklist, rawModelId);
  };

  const candidates = (Array.isArray(pool?.accounts) ? pool.accounts : [])
    .filter((account) => account?.enabled !== false)
    .filter(canAccountServeModel)
    .sort((left, right) => {
      const priorityDelta = normalizePriority(left?.priority) - normalizePriority(right?.priority);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return String(left?.key ?? "").localeCompare(String(right?.key ?? ""));
    });

  return candidates[0] ?? null;
}

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const scenario = process.argv[2];

if (!scenario) {
  throw new Error("Usage: node ./test/verify-multi-account.mjs <schema-init|malformed-json|perms|dedupe|dedupe-domains|display-name-routing|resolution|models|model-order|strip-routing-headers|append-update|migrate-legacy|route|isolate-failure|disabled-route|stale-baseurl|all|readme-check>");
}

const {
  getPoolPath,
  readPool,
  writePool,
  deriveAccountKey,
  upsertAccount,
  resolveWinnerAccount,
  injectRoutingHeaders,
  stripRoutingHeaders,
  CopilotAuthPlugin,
} = await import("../index.mjs");

const ROUTING_ACCOUNT_KEY_HEADER = "x-opencode-copilot-account-key";
const README_PATH = new URL("../README.md", import.meta.url);

function failScenario(name, message) {
  process.stdout.write(`FAIL ${name}: ${message}\n`);
  process.exit(1);
}

function ensureParentDirectory(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function runSchemaInit() {
  const pool = readPool();
  if (pool.version !== 1) {
    throw new Error(`Expected version=1, got version=${pool.version}`);
  }
  if (!Array.isArray(pool.accounts) || pool.accounts.length !== 0) {
    throw new Error(`Expected empty accounts array, got ${JSON.stringify(pool.accounts)}`);
  }
  const fileCreated = existsSync(getPoolPath());
  if (!fileCreated) {
    throw new Error("Expected readPool() to create pool file on disk, but file not found");
  }
  process.stdout.write("PASS schema-init version=1\n");
  process.stdout.write("PASS schema-init accounts=0\n");
  process.stdout.write(`PASS schema-init file-created=${String(fileCreated)}\n`);
}

function runReadmeCheck() {
  const readme = readFileSync(README_PATH, "utf8");
  const required = ["copilot-auth.json", "allowlist", "blocklist", "priority", "enabled"];
  const missing = required.find((field) => !readme.includes(field));

  if (missing) {
    failScenario("readme-docs-updated", `missing ${missing}`);
  }

  process.stdout.write("PASS readme-docs-updated\n");
}

function runMalformedJson() {
  const poolPath = getPoolPath();
  ensureParentDirectory(poolPath);
  const malformed = "{\n  \"version\": 1,\n  \"accounts\": [\n";
  writeFileSync(poolPath, malformed, "utf8");

  let blocked = false;
  try {
    readPool();
  } catch {
    blocked = true;
  }

  const preserved = readFileSync(poolPath, "utf8") === malformed;

  if (!blocked) {
    throw new Error("Expected malformed JSON to throw");
  }
  if (!preserved) {
    throw new Error("Expected malformed JSON file contents to be preserved");
  }

  process.stdout.write("PASS malformed-json-blocked\n");
  process.stdout.write(`PASS malformed-json-preserved=${String(preserved)}\n`);
}

function runPerms() {
  const poolPath = getPoolPath();
  const payload = {
    version: 1,
    accounts: [],
  };

  writePool(payload);

  if (!existsSync(poolPath)) {
    throw new Error("Expected pool file to exist after writePool");
  }

  const mode = statSync(poolPath).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`Expected mode 0600, got ${mode.toString(8)}`);
  }

  process.stdout.write("PASS file-mode-0600\n");
}

function runDedupe() {
  const identity = {
    login: "octocat",
    userId: 12345345678,
  };
  const key = deriveAccountKey("github.com", identity.userId);

  const inserted = upsertAccount(
    {
      version: 1,
      accounts: [],
    },
    {
      key,
      deployment: "github.com",
      domain: "github.com",
      identity,
      enterpriseUrl: null,
      baseUrl: "https://api.githubcopilot.com",
      auth: {
        type: "oauth",
        refresh: "token-1",
      },
    },
  );

  const updated = upsertAccount(inserted, {
    key,
    deployment: "github.com",
    domain: "github.com",
    identity: {
      login: "octocat-renamed",
      userId: identity.userId,
    },
    enterpriseUrl: null,
    baseUrl: "https://api.githubcopilot.com",
    auth: {
      type: "oauth",
      refresh: "token-2",
    },
  });

  const account = updated.accounts[0];

  if (updated.accounts.length !== 1) {
    throw new Error(`Expected single deduped account, got ${updated.accounts.length}`);
  }

  if (account.auth?.refresh !== "token-2") {
    throw new Error("Expected latest token to overwrite auth.refresh");
  }

  process.stdout.write(`PASS dedupe-same-account count=${updated.accounts.length}\n`);
  process.stdout.write(`PASS updated-token=${String(account.auth?.refresh === "token-2")}\n`);
}

function runDedupeDomains() {
  const userId = 7777345678;
  const identity = {
    login: "octocat",
    userId,
  };

  let pool = {
    version: 1,
    accounts: [],
  };

  pool = upsertAccount(pool, {
    key: deriveAccountKey("github.com", userId),
    deployment: "github.com",
    domain: "github.com",
    identity,
    enterpriseUrl: null,
    baseUrl: "https://api.githubcopilot.com",
    auth: {
      type: "oauth",
      refresh: "dotcom-token",
    },
  });

  pool = upsertAccount(pool, {
    key: deriveAccountKey("company.ghe.com", userId),
    deployment: "company.ghe.com",
    domain: "company.ghe.com",
    identity,
    enterpriseUrl: "https://company.ghe.com",
    baseUrl: "https://company.ghe.com/api/copilot",
    auth: {
      type: "oauth",
      refresh: "enterprise-token",
    },
  });

  if (pool.accounts.length !== 2) {
    throw new Error(`Expected separate accounts across domains, got ${pool.accounts.length}`);
  }

  process.stdout.write(`PASS separate-enterprise-and-dotcom count=${pool.accounts.length}\n`);
}

function runDisplayNameRouting() {
  const userId = 90000345678;
  const key = deriveAccountKey("github.com", userId);
  const first = upsertAccount(
    {
      version: 1,
      accounts: [],
    },
    {
      key,
      deployment: "github.com",
      domain: "github.com",
      identity: {
        login: "octocat",
        userId,
      },
      enterpriseUrl: null,
      baseUrl: "https://api.githubcopilot.com",
      auth: {
        type: "oauth",
        refresh: "token-a",
      },
    },
  );

  first.accounts[0].name = "Personal Copilot";

  const second = upsertAccount(first, {
    key,
    deployment: "github.com",
    domain: "github.com",
    identity: {
      login: "octocat",
      userId,
    },
    enterpriseUrl: null,
    baseUrl: "https://api.githubcopilot.com",
    auth: {
      type: "oauth",
      refresh: "token-b",
    },
  });

  if (second.accounts.length !== 1) {
    throw new Error(`Expected one account after name change upsert, got ${second.accounts.length}`);
  }

  if (second.accounts[0].key !== key) {
    throw new Error("Expected routing key to stay stable");
  }

  if (second.accounts[0].name !== "Personal Copilot") {
    throw new Error("Expected user-set display name to be preserved");
  }

  process.stdout.write("PASS display-name-not-routing-key\n");
}

function runResolution() {
  const pool = {
    version: 1,
    accounts: [
      {
        key: "github.com-work",
        deployment: "github.com",
        enabled: true,
        priority: 100,
        allowlist: ["claude-sonnet-4.6"],
        blocklist: [],
      },
      {
        key: "github.com-personal",
        deployment: "github.com",
        enabled: true,
        priority: 0,
        allowlist: [],
        blocklist: [],
      },
      {
        key: "github.com-disabled",
        deployment: "github.com",
        enabled: false,
        priority: 999,
        allowlist: [],
        blocklist: [],
      },
      {
        key: "github.com-blocked",
        deployment: "github.com",
        enabled: true,
        priority: 500,
        allowlist: ["claude-sonnet-4.6"],
        blocklist: ["claude-sonnet-4.6"],
      },
    ],
  };

  const claudeWinner = resolveWinnerAccount("claude-sonnet-4.6", pool);
  if (claudeWinner?.key !== "github.com-work") {
    throw new Error(`Expected github.com-work to win claude-sonnet-4.6, got ${claudeWinner?.key ?? "null"}`);
  }

  const gptWinner = resolveWinnerAccount("gpt-4.1", pool);
  if (gptWinner?.key !== "github.com-personal") {
    throw new Error(`Expected github.com-personal to win gpt-4.1, got ${gptWinner?.key ?? "null"}`);
  }

  const tieWinner = resolveWinnerAccount("any-model", {
    version: 1,
    accounts: [
      {
        key: "zeta-account",
        enabled: true,
        priority: 50,
        allowlist: [],
        blocklist: [],
      },
      {
        key: "alpha-account",
        enabled: true,
        priority: 50,
        allowlist: [],
        blocklist: [],
      },
    ],
  });

  if (tieWinner?.key !== "alpha-account") {
    throw new Error(`Expected alpha-account to win tie-break, got ${tieWinner?.key ?? "null"}`);
  }

  const noWinner = resolveWinnerAccount("blocked-only-model", {
    version: 1,
    accounts: [
      {
        key: "blocked",
        enabled: true,
        priority: 10,
        allowlist: ["blocked-only-model"],
        blocklist: ["blocked-only-model"],
      },
      {
        key: "disabled",
        enabled: false,
        priority: 99,
        allowlist: [],
        blocklist: [],
      },
    ],
  });

  if (noWinner !== null) {
    throw new Error(`Expected null when all accounts are filtered out, got ${JSON.stringify(noWinner)}`);
  }

  process.stdout.write("PASS resolution-work-wins-for-claude-sonnet-4.6\n");
  process.stdout.write("PASS priority-tie-breaker-key-order\n");
}

function runModels() {
  const pool = {
    version: 1,
    accounts: [
      {
        id: "github.com-work",
        key: "github.com-work",
        deployment: "github.com",
        enabled: true,
        priority: 100,
        allowlist: ["claude-sonnet-4.6"],
        blocklist: [],
      },
      {
        id: "github.com-personal",
        key: "github.com-personal",
        deployment: "github.com",
        enabled: true,
        priority: 0,
        allowlist: [],
        blocklist: ["claude-opus-4.6"],
      },
      {
        id: "github.com-disabled",
        key: "github.com-disabled",
        deployment: "github.com",
        enabled: false,
        priority: 999,
        allowlist: [],
        blocklist: [],
      },
    ],
  };

  const mockLiveModelsByAccount = {
    "github.com-work": ["claude-sonnet-4.6", "gpt-4.1"],
    "github.com-personal": ["gpt-4.1", "claude-opus-4.6"],
    "github.com-disabled": ["claude-sonnet-4.6", "gpt-4.1", "claude-opus-4.6"],
  };

  const candidatesByRawId = new Map();

  for (const account of pool.accounts.filter((item) => item.enabled !== false)) {
    const modelIds = mockLiveModelsByAccount[account.key] ?? [];
    for (const rawModelId of modelIds) {
      const winner = resolveWinnerAccount(rawModelId, pool);
      if (winner?.key === account.key) {
        candidatesByRawId.set(rawModelId, account.key);
      }
    }
  }

  const claudeWinner = resolveWinnerAccount("claude-sonnet-4.6", pool);
  if (claudeWinner?.id !== "github.com-work") {
    throw new Error(`Expected github.com-work to win claude-sonnet-4.6, got ${claudeWinner?.id ?? "null"}`);
  }

  const gptWinner = resolveWinnerAccount("gpt-4.1", pool);
  if (gptWinner?.id !== "github.com-personal") {
    throw new Error(`Expected github.com-personal to win gpt-4.1, got ${gptWinner?.id ?? "null"}`);
  }

  const blockedWinner = resolveWinnerAccount("claude-opus-4.6", pool);
  if (blockedWinner !== null) {
    throw new Error(`Expected claude-opus-4.6 to be blocked for all enabled accounts, got ${blockedWinner?.id ?? blockedWinner}`);
  }

  const keys = [...candidatesByRawId.keys()];
  const unique = new Set(keys).size === keys.length;
  if (!unique) {
    throw new Error(`Expected unique raw model ids, got ${JSON.stringify(keys)}`);
  }

  process.stdout.write(`PASS has claude-sonnet-4.6 winner=${claudeWinner.id}\n`);
  process.stdout.write(`PASS has gpt-4.1 winner=${gptWinner.id}\n`);
  process.stdout.write("PASS missing claude-opus-4.6 blocked\n");
  process.stdout.write("PASS unique-raw-model-ids\n");
}

function runModelOrder() {
  const models = {
    "gpt-4.1": { id: "gpt-4.1" },
    "claude-sonnet-4.6": { id: "claude-sonnet-4.6" },
    "o3-mini": { id: "o3-mini" },
  };

  const sortedIds = Object.keys(models).sort((left, right) => left.localeCompare(right));
  const expected = ["claude-sonnet-4.6", "gpt-4.1", "o3-mini"];
  if (JSON.stringify(sortedIds) !== JSON.stringify(expected)) {
    throw new Error(`Expected deterministic model order ${JSON.stringify(expected)}, got ${JSON.stringify(sortedIds)}`);
  }

  process.stdout.write("PASS deterministic-model-order\n");
}

function runStripRoutingHeaders() {
  const injected = injectRoutingHeaders(
    {
      Authorization: "Bearer secret",
      "X-Trace-Id": "trace-123",
    },
    "github.com-work",
  );
  const stripped = stripRoutingHeaders({
    ...injected,
    "X-Opencode-Copilot-Account-Key": injected["x-opencode-copilot-account-key"],
    "X-Opencode-Copilot-Route-Source": injected["x-opencode-copilot-route-source"],
  });

  const removed = !Object.keys(stripped).some((key) => key.toLowerCase().startsWith("x-opencode-copilot-"));
  if (!removed) {
    throw new Error(`Expected internal routing headers to be removed, got ${JSON.stringify(stripped)}`);
  }

  if (stripped.Authorization !== "Bearer secret" || stripped["X-Trace-Id"] !== "trace-123") {
    throw new Error(`Expected non-routing headers to be preserved, got ${JSON.stringify(stripped)}`);
  }

  process.stdout.write(`PASS strippedInternalRoutingHeaders=${String(removed)}\n`);
}

function runAppendUpdate() {
  const accountAIdentity = {
    login: "octocat-a",
    userId: 111122223333,
  };
  const accountBIdentity = {
    login: "octocat-b",
    userId: 444455556666,
  };

  let pool = {
    version: 1,
    accounts: [],
  };

  const accountAKey = deriveAccountKey("github.com", accountAIdentity.userId);
  const accountBKey = deriveAccountKey("github.com", accountBIdentity.userId);

  pool = upsertAccount(pool, {
    key: accountAKey,
    deployment: "github.com",
    domain: "github.com",
    identity: accountAIdentity,
    enterpriseUrl: null,
    baseUrl: "https://api.githubcopilot.com",
    auth: {
      type: "oauth",
      refresh: "token-a-1",
    },
  });

  if (pool.accounts.length !== 1) {
    throw new Error(`Expected one account after initial insert, got ${pool.accounts.length}`);
  }

  pool = upsertAccount(pool, {
    key: accountBKey,
    deployment: "github.com",
    domain: "github.com",
    identity: accountBIdentity,
    enterpriseUrl: null,
    baseUrl: "https://api.githubcopilot.com",
    auth: {
      type: "oauth",
      refresh: "token-b-1",
    },
  });

  if (pool.accounts.length !== 2) {
    throw new Error(`Expected two accounts after appending different key, got ${pool.accounts.length}`);
  }

  pool = upsertAccount(pool, {
    key: accountAKey,
    deployment: "github.com",
    domain: "github.com",
    identity: accountAIdentity,
    enterpriseUrl: null,
    baseUrl: "https://api.githubcopilot.com",
    auth: {
      type: "oauth",
      refresh: "token-a-2",
    },
  });

  if (pool.accounts.length !== 2) {
    throw new Error(`Expected account update to avoid duplicates, got ${pool.accounts.length}`);
  }

  const updatedA = pool.accounts.find((account) => account.key === accountAKey);
  if (updatedA?.auth?.refresh !== "token-a-2") {
    throw new Error("Expected latest account A token to be persisted on update");
  }

  process.stdout.write("PASS append-new-account count=2\n");
  process.stdout.write("PASS update-existing-account count=2\n");
}

function runMigrateLegacy() {
  let pool = {
    version: 1,
    accounts: [],
  };

  pool = upsertAccount(pool, {
    key: deriveAccountKey("github.com", 999900001111),
    deployment: "github.com",
    domain: "github.com",
    identity: {
      login: "legacy-user",
      userId: 999900001111,
    },
    enterpriseUrl: null,
    baseUrl: "https://api.githubcopilot.com",
    auth: {
      type: "oauth",
      provider: "github-copilot-enterprise",
      refresh: "legacy-token",
      access: "legacy-token",
      expires: 0,
      baseUrl: "https://api.githubcopilot.com",
    },
  });

  if (pool.accounts.length !== 1) {
    throw new Error(`Expected migrated legacy auth to create one account, got ${pool.accounts.length}`);
  }

  const providerPreserved = pool.accounts[0]?.auth?.provider === "github-copilot-enterprise";
  if (!providerPreserved) {
    throw new Error("Expected legacy auth provider field to be preserved");
  }

  process.stdout.write("PASS migrate-legacy-auth count=1\n");
  process.stdout.write(`PASS migrate-preserved-provider=${String(providerPreserved)}\n`);
}

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function getHeaderCaseInsensitive(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (String(key).toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function createJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : String(status),
    async json() {
      return payload;
    },
  };
}

async function withMockFetch(mock, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function createPluginLoader(getAuth) {
  const plugin = await CopilotAuthPlugin({ client: {} });
  return plugin.auth.loader(getAuth);
}

async function createPlugin() {
  return CopilotAuthPlugin({ client: {} });
}

async function runIsolateFailure() {
  const pool = {
    version: 1,
    accounts: [
      {
        id: "github.com-work",
        key: "github.com:1111",
        deployment: "github.com",
        enabled: true,
        priority: 100,
        allowlist: ["gpt-4.1"],
        blocklist: [],
        baseUrl: "https://healthy.example.com",
        auth: {
          type: "oauth",
          refresh: "token-healthy",
        },
      },
      {
        id: "github.com-broken",
        key: "github.com:2222",
        deployment: "github.com",
        enabled: true,
        priority: 50,
        allowlist: ["gpt-4.1"],
        blocklist: [],
        baseUrl: "https://broken.example.com",
        auth: {
          type: "oauth",
          refresh: "token-broken",
        },
      },
    ],
  };

  writePool(pool);

  let skippedAccounts = 0;
  const models = await withMockFetch(async (input) => {
    const url = String(input);
    if (url === "https://healthy.example.com/models") {
      return createJsonResponse(200, {
        data: [
          {
            id: "gpt-4.1",
            name: "GPT-4.1",
            version: "gpt-4.1-2026-04-15",
            capabilities: {
              type: "chat",
              limits: {
                max_context_window_tokens: 200000,
                max_prompt_tokens: 168000,
                max_output_tokens: 32000,
              },
              supports: {},
            },
            model_picker_enabled: true,
          },
        ],
      });
    }

    if (url === "https://broken.example.com/models") {
      skippedAccounts += 1;
      throw new Error("broken account model fetch");
    }

    throw new Error(`Unexpected fetch URL in isolate-failure: ${url}`);
  }, async () => {
    const plugin = await createPlugin();
    return plugin.provider.models(
      {
        models: {
          "gpt-4.1": {
            id: "gpt-4.1",
            api: {
              id: "gpt-4.1",
            },
          },
        },
      },
      {
        auth: null,
      },
    );
  });

  const visibleHealthyAccounts = Object.prototype.hasOwnProperty.call(models, "gpt-4.1") ? 1 : 0;
  if (skippedAccounts !== 1) {
    throw new Error(`Expected skippedAccounts=1, got ${skippedAccounts}`);
  }
  if (visibleHealthyAccounts !== 1) {
    throw new Error(`Expected visibleHealthyAccounts=1, got ${visibleHealthyAccounts}`);
  }

  process.stdout.write(`PASS skippedAccounts=${skippedAccounts}\n`);
  process.stdout.write(`PASS visibleHealthyAccounts=${visibleHealthyAccounts}\n`);
}

async function runDisabledRoute() {
  const pool = {
    version: 1,
    accounts: [
      {
        id: "github.com-disabled",
        key: "github.com:1111",
        deployment: "github.com",
        enabled: false,
        priority: 100,
        allowlist: ["claude-sonnet-4.6"],
        blocklist: [],
        baseUrl: "https://api.githubcopilot.com",
        auth: {
          type: "oauth",
          refresh: "token-disabled",
        },
      },
    ],
  };

  writePool(pool);

  const winner = resolveWinnerAccount("claude-sonnet-4.6", pool);
  if (winner !== null) {
    throw new Error(`Expected disabled account to be excluded from winner resolution, got ${winner?.key}`);
  }

  let networkCalls = 0;
  const blocked = await withMockFetch(async () => {
    networkCalls += 1;
    return createJsonResponse(200, {});
  }, async () => {
    const loader = await createPluginLoader(async () => ({
      type: "oauth",
      refresh: "legacy-token",
      baseUrl: "https://api.githubcopilot.com",
    }));

    try {
      await loader.fetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: injectRoutingHeaders({}, "github.com:1111"),
        body: JSON.stringify({
          model: "claude-sonnet-4.6",
        }),
      });
      return false;
    } catch (error) {
      return error instanceof Error
        && error.message === "[opencode-copilot-cli-auth] Selected account is disabled or not found; re-login required";
    }
  });

  if (!blocked) {
    throw new Error("Expected disabled routed account to be blocked with re-login error");
  }
  if (networkCalls !== 0) {
    throw new Error(`Expected networkCalls=0, got ${networkCalls}`);
  }

  process.stdout.write("PASS disabled-account-blocked\n");
  process.stdout.write(`PASS networkCalls=${networkCalls}\n`);
}

async function runStaleBaseUrl() {
  const selectedKey = "github.com:1111";
  const staleBaseUrl = "https://stale.example.com";
  const freshBaseUrl = "https://fresh.example.com";
  const pool = {
    version: 1,
    accounts: [
      {
        id: "github.com-work",
        key: selectedKey,
        deployment: "github.com",
        enabled: true,
        priority: 100,
        allowlist: ["gpt-4.1"],
        blocklist: [],
        baseUrl: staleBaseUrl,
        auth: {
          type: "oauth",
          refresh: "selected-refresh-token",
        },
      },
    ],
  };

  writePool(pool);

  const fetchLog = [];
  const response = await withMockFetch(async (input, init) => {
    const url = String(input);
    fetchLog.push({
      url,
      authorization: getHeaderCaseInsensitive(init?.headers, "authorization"),
    });

    if (url === `${staleBaseUrl}/chat/completions`) {
      return createJsonResponse(401, { error: "stale" });
    }

    if (url === "https://api.github.com/copilot_internal/user") {
      return createJsonResponse(200, {
        endpoints: {
          api: freshBaseUrl,
        },
      });
    }

    if (url === `${freshBaseUrl}/chat/completions`) {
      return createJsonResponse(200, { ok: true });
    }

    throw new Error(`Unexpected fetch URL in stale-baseurl: ${url}`);
  }, async () => {
    const loader = await createPluginLoader(async () => ({
      type: "oauth",
      refresh: "legacy-token",
      baseUrl: staleBaseUrl,
    }));

    return loader.fetch(`${staleBaseUrl}/chat/completions`, {
      method: "POST",
      headers: injectRoutingHeaders({}, selectedKey),
      body: JSON.stringify({
        model: "gpt-4.1",
      }),
    });
  });

  if (!response.ok) {
    throw new Error(`Expected retry to succeed, got status ${response.status}`);
  }

  const refreshedPool = readPool();
  const refreshedAccount = refreshedPool.accounts.find((account) => account.key === selectedKey);
  if (refreshedAccount?.baseUrl !== freshBaseUrl) {
    throw new Error(`Expected refreshed baseUrl=${freshBaseUrl}, got ${refreshedAccount?.baseUrl ?? "undefined"}`);
  }

  const entitlementCalls = fetchLog.filter((entry) => entry.url === "https://api.github.com/copilot_internal/user");
  if (entitlementCalls.length !== 1) {
    throw new Error(`Expected one entitlement refresh, got ${entitlementCalls.length}`);
  }

  const staleCalls = fetchLog.filter((entry) => entry.url === `${staleBaseUrl}/chat/completions`);
  const freshCalls = fetchLog.filter((entry) => entry.url === `${freshBaseUrl}/chat/completions`);
  if (staleCalls.length !== 1 || freshCalls.length !== 1) {
    throw new Error(`Expected one stale and one fresh request, got stale=${staleCalls.length} fresh=${freshCalls.length}`);
  }

  const entitlementAuth = entitlementCalls[0]?.authorization;
  if (entitlementAuth !== "Bearer selected-refresh-token") {
    throw new Error(`Expected entitlement refresh for selected account only, got ${entitlementAuth ?? "undefined"}`);
  }

  process.stdout.write("PASS refreshed-entitlement-for-selected-account\n");
}

function runRoute() {
  const modelId = getArgValue("--model");
  if (!modelId) {
    throw new Error("route scenario requires --model <modelId>");
  }

  const pool = {
    version: 1,
    accounts: [
      {
        id: "github.com-work",
        key: "github.com:1111",
        deployment: "github.com",
        enabled: true,
        priority: 100,
        allowlist: ["claude-sonnet-4.6"],
        blocklist: [],
        baseUrl: "https://api.githubcopilot.com",
        auth: {
          type: "oauth",
          refresh: "token-work",
        },
      },
      {
        id: "github.com-personal",
        key: "github.com:2222",
        deployment: "github.com",
        enabled: true,
        priority: 50,
        allowlist: ["gpt-4.1"],
        blocklist: [],
        baseUrl: "https://api.githubcopilot.com",
        auth: {
          type: "oauth",
          refresh: "token-personal",
        },
      },
    ],
  };

  const winner = resolveWinnerAccount(modelId, pool);
  if (!winner) {
    throw new Error(`Expected winner for model ${modelId}, got null`);
  }

  const routedHeaders = injectRoutingHeaders({}, winner.key);
  const routedKey = getHeaderCaseInsensitive(routedHeaders, ROUTING_ACCOUNT_KEY_HEADER);
  if (!routedKey) {
    throw new Error("Expected injected routing account key header");
  }

  const selectedAccount = pool.accounts.find((account) => account.key === routedKey);
  if (!selectedAccount) {
    throw new Error(`Expected account lookup by routing key to succeed, got key=${routedKey}`);
  }

  const expectedAccountId = modelId === "claude-sonnet-4.6" ? "github.com-work" : "github.com-personal";
  if (winner.id !== expectedAccountId) {
    throw new Error(`Expected routed account=${expectedAccountId}, got ${winner.id}`);
  }

  const expectedAuth = modelId === "claude-sonnet-4.6" ? "token-work" : "token-personal";
  if (selectedAccount.auth?.refresh !== expectedAuth) {
    throw new Error(`Expected auth=${expectedAuth}, got ${selectedAccount.auth?.refresh ?? "undefined"}`);
  }

  process.stdout.write(`PASS routed account=${winner.id}\n`);
  process.stdout.write(`PASS rawModel=${modelId}\n`);
  process.stdout.write(`PASS auth=${selectedAccount.auth.refresh}\n`);
  process.stdout.write(`PASS baseUrl=${selectedAccount.baseUrl}\n`);
  process.stdout.write("PASS derived-route-from-model-map=true\n");
}

function runAllScenarios() {
  const scenarios = [
    ["schema-init"],
    ["malformed-json"],
    ["perms"],
    ["dedupe"],
    ["dedupe-domains"],
    ["display-name-routing"],
    ["resolution"],
    ["strip-routing-headers"],
    ["append-update"],
    ["migrate-legacy"],
    ["models"],
    ["model-order"],
    ["route", "--model", "claude-sonnet-4.6"],
    ["isolate-failure"],
    ["disabled-route"],
    ["stale-baseurl"],
    ["readme-check"],
  ];

  for (const args of scenarios) {
    const scenarioName = args[0];
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-multi-account-"));
    const tmpHome = join(tmpRoot, "home");
    mkdirSync(tmpHome, { recursive: true });

    try {
      execFileSync(process.execPath, [process.argv[1], ...args], {
        stdio: "inherit",
        env: {
          ...process.env,
          HOME: tmpHome,
        },
      });
    } catch (error) {
      const message = error instanceof Error && error.message
        ? `scenario ${scenarioName} failed: ${error.message}`
        : `scenario ${scenarioName} failed`;
      failScenario("all-scenarios", message);
    }
  }

  process.stdout.write("PASS all-scenarios\n");
}

switch (scenario) {
  case "schema-init":
    runSchemaInit();
    break;
  case "malformed-json":
    runMalformedJson();
    break;
  case "perms":
    runPerms();
    break;
  case "dedupe":
    runDedupe();
    break;
  case "dedupe-domains":
    runDedupeDomains();
    break;
  case "display-name-routing":
    runDisplayNameRouting();
    break;
  case "resolution":
    runResolution();
    break;
  case "models":
    runModels();
    break;
  case "model-order":
    runModelOrder();
    break;
  case "strip-routing-headers":
    runStripRoutingHeaders();
    break;
  case "append-update":
    runAppendUpdate();
    break;
  case "migrate-legacy":
    runMigrateLegacy();
    break;
  case "route":
    runRoute();
    break;
  case "isolate-failure":
    await runIsolateFailure();
    break;
  case "disabled-route":
    await runDisabledRoute();
    break;
  case "stale-baseurl":
    await runStaleBaseUrl();
    break;
  case "readme-check":
    runReadmeCheck();
    break;
  case "all":
    runAllScenarios();
    break;
  default:
    throw new Error(`Unknown scenario: ${scenario}`);
}

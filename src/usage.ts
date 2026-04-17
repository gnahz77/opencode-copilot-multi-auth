import { fetchEntitlement } from "./auth.js";
import { readPool } from "./pool.js";
import type { PoolAccount } from "./types.js";

export interface QuotaDetail {
  entitlement: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_id: string;
  quota_remaining: number;
  remaining: number;
  unlimited: boolean;
}

interface QuotaSnapshots {
  chat?: QuotaDetail;
  completions?: QuotaDetail;
  premium_interactions?: QuotaDetail;
}

interface CopilotUsageResponse {
  quota_snapshots?: QuotaSnapshots;
}

type UsageSnapshotKey = keyof QuotaSnapshots;

const USAGE_SNAPSHOT_PREFERENCE: UsageSnapshotKey[] = ["premium_interactions", "chat", "completions"];

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundToTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

function buildProgressBar(percentUsed: number, width = 16) {
  const normalizedWidth = Math.max(8, width);
  const filled = Math.round((clamp(percentUsed, 0, 100) / 100) * normalizedWidth);
  return `[${"#".repeat(filled)}${"-".repeat(normalizedWidth - filled)}]`;
}

function resolveUsageDetail(payload: CopilotUsageResponse) {
  const snapshots = payload?.quota_snapshots;
  if (!snapshots || typeof snapshots !== "object") return null;

  for (const key of USAGE_SNAPSHOT_PREFERENCE) {
    const candidate = snapshots[key];
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.unlimited) continue;
    const total = numberOrZero(candidate.entitlement);
    if (total > 0) {
      return candidate;
    }
  }

  for (const key of USAGE_SNAPSHOT_PREFERENCE) {
    const candidate = snapshots[key];
    if (!candidate || typeof candidate !== "object") continue;
    return candidate;
  }

  return null;
}

function formatUsageNumbers(detail: QuotaDetail) {
  if (detail.unlimited) {
    return {
      used: 0,
      total: 0,
      percentUsed: 0,
      unlimited: true,
    };
  }

  const total = Math.max(0, numberOrZero(detail.entitlement));
  const remaining = Math.max(0, numberOrZero(detail.remaining));
  const used = clamp(total - remaining, 0, total);
  const percentRemaining = clamp(numberOrZero(detail.percent_remaining), 0, 100);
  const percentUsed = total > 0 ? roundToTwoDecimals(clamp(100 - percentRemaining, 0, 100)) : 0;

  return {
    used,
    total,
    percentUsed,
    unlimited: false,
  };
}

function getAccountLabel(account: PoolAccount) {
  const base = account.name || account.identity?.login || account.id || account.key;
  const login = account.identity?.login?.trim();
  if (login && login !== base) {
    return `${base} (@${login})`;
  }
  return base;
}

async function getCopilotUsageSummary(account: PoolAccount) {
  const accountLabel = getAccountLabel(account);
  const statusSuffix = account.enabled === false ? " [disabled]" : "";

  if (
    account.auth?.type !== "oauth"
    || typeof account.auth.refresh !== "string"
    || !account.auth.refresh.trim()
  ) {
    return [`${accountLabel}${statusSuffix}`, "OAuth token missing"].join("\n");
  }

  try {
    const payload = (await fetchEntitlement({
      refresh: account.auth.refresh,
      enterpriseUrl: account.enterpriseUrl,
      baseUrl: account.baseUrl,
    })) as CopilotUsageResponse;

    const detail = resolveUsageDetail(payload);
    if (!detail) {
      return [`${accountLabel}${statusSuffix}`, "Usage unavailable"].join("\n");
    }

    const usage = formatUsageNumbers(detail);
    if (usage.unlimited) {
      return [`${accountLabel}${statusSuffix}`, "Usage: Unlimited", "Used: N/A"].join("\n");
    }

    return [
      `${accountLabel}${statusSuffix}`,
      `${buildProgressBar(usage.percentUsed)} ${usage.used}/${usage.total}`,
      `Used: ${usage.percentUsed}%`,
    ].join("\n");
  } catch (error) {
    return [
      `${accountLabel}${statusSuffix}`,
      error instanceof Error ? error.message : String(error),
    ].join("\n");
  }
}

export async function getCopilotUsageDialogMessage() {
  const pool = readPool();
  const accounts = [...pool.accounts].sort((left, right) => left.key.localeCompare(right.key));

  if (accounts.length === 0) {
    throw new Error("No Copilot accounts found in the account pool. Log in again to populate ~/.local/share/opencode/copilot-auth.json.");
  }

  const sections = await Promise.all(accounts.map((account) => getCopilotUsageSummary(account)));
  return sections.join("\n\n");
}

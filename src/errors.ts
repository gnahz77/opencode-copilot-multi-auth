export function getSelectedAccountMissingError() {
  return new Error(
    "[opencode-copilot-cli-auth] Selected account is disabled or not found; re-login required",
  );
}

export function getSelectedAccountExpiredError(accountKey: string) {
  return new Error(
    `[opencode-copilot-cli-auth] Account auth expired for ${accountKey}; re-login required`,
  );
}

export const ACCOUNT_POOL_SCHEMA_VERSION = 1;
export const ROUTING_ACCOUNT_KEY_HEADER = "x-opencode-copilot-account-key";
export const ROUTING_SOURCE_HEADER = "x-opencode-copilot-route-source";
export const INTERNAL_ROUTING_HEADERS = new Set([
  ROUTING_ACCOUNT_KEY_HEADER,
  ROUTING_SOURCE_HEADER,
]);

export const CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const API_VERSION = "2025-05-01";
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
export const OAUTH_SCOPES = "read:user read:org repo gist";
export const DEFAULT_COPILOT_BASE_URL = "https://api.githubcopilot.com";
export const COPILOT_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export const VSCODE_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.38.0",
  "Editor-Version": "vscode/1.110.1",
  "Editor-Plugin-Version": "copilot-chat/0.38.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

export const RESPONSES_API_ALTERNATE_INPUT_TYPES = [
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
] as const;

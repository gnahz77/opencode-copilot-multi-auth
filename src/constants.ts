export const ACCOUNT_POOL_SCHEMA_VERSION = 1;
export const ROUTING_ACCOUNT_KEY_HEADER = "x-opencode-copilot-account-key";
export const ROUTING_SOURCE_HEADER = "x-opencode-copilot-route-source";
export const INTERNAL_ROUTING_HEADERS = new Set([
  ROUTING_ACCOUNT_KEY_HEADER,
  ROUTING_SOURCE_HEADER,
]);

export const CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm";
export const API_VERSION = "2025-05-01";
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
export const OAUTH_SCOPES = "read:user read:org repo gist";

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

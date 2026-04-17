export interface PoolIdentity {
  login: string;
  userId: number;
}

export interface OAuthAuth {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
  baseUrl?: string | null;
  provider?: string;
  enterpriseUrl?: string;
}

export interface PoolAccount {
  key: string;
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  deployment: string;
  domain: string;
  identity: PoolIdentity;
  enterpriseUrl: string | null;
  baseUrl: string | null;
  allowlist: string[];
  blocklist: string[];
  auth: OAuthAuth;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAccountData {
  key: string;
  deployment?: string;
  domain?: string;
  identity?: Partial<PoolIdentity>;
  enterpriseUrl?: string | null;
  baseUrl?: string | null;
  auth?: OAuthAuth;
  authResult?: OAuthAuth;
}

export interface AccountPool {
  version: number;
  accounts: PoolAccount[];
}

export interface LiveModel {
  id: string;
  name?: string;
  version?: string;
  model_picker_enabled?: boolean;
  capabilities?: {
    type?: string;
    family?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_prompt_tokens?: number;
      max_output_tokens?: number;
      max_non_streaming_output_tokens?: number;
      vision?: boolean;
    };
    supports?: {
      vision?: boolean;
      tool_calls?: boolean;
      adaptive_thinking?: boolean;
      max_thinking_budget?: number;
      reasoning_effort?: string[];
    };
  };
}

export interface ProviderModel {
  id: string;
  api?: {
    id?: string;
    url?: string;
    npm?: string;
  };
  name?: string;
  family?: string;
  cost?: unknown;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  capabilities?: {
    temperature?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    interleaved?: boolean;
    input?: {
      text?: boolean;
      audio?: boolean;
      image?: boolean;
      video?: boolean;
      pdf?: boolean;
    };
    output?: {
      text?: boolean;
      audio?: boolean;
      image?: boolean;
      video?: boolean;
      pdf?: boolean;
    };
  };
  options?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  release_date?: string;
  variants?: Record<string, unknown>;
  status?: string;
}

export type HeaderObject =
  | Headers
  | Array<[string, string]>
  | Record<string, string>
  | undefined;

export interface AuthInput {
  refresh: string;
  enterpriseUrl?: string | null;
  baseUrl?: string | null;
  type?: string;
}

export interface DeviceFlowAuthorizeResult {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  baseUrl?: string;
  provider?: string;
  enterpriseUrl?: string;
}

export interface ConversationMetadata {
  isVision: boolean;
  isAgent: boolean;
}

export interface ChatHeadersMessagePart {
  type?: string;
}

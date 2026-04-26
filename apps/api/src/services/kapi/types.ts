export interface KapiKeyValue {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

export interface KapiAuthConfig {
  kind: 'none' | 'bearer' | 'basic' | 'api-key' | 'custom';
  tokenVar?: string;
  headerName?: string;
  username?: string;
  passwordVar?: string;
  [extra: string]: unknown;
}

export type KapiBodyType = 'none' | 'raw' | 'form-data' | 'x-www-form' | 'binary' | 'graphql';
export type KapiBodyLanguage = 'json' | 'xml' | 'text' | 'graphql' | 'html' | 'yaml';
export type KapiHttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface KapiCollection {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  allow_insecure_tls: boolean;
  created_at: string;
  updated_at: string;
}

export interface KapiDefinition {
  id: string;
  collection_id: string;
  handle: string;
  name: string;
  description: string | null;
  base_url: string | null;
  default_auth: KapiAuthConfig;
  openapi_source: string | null;
  created_at: string;
  updated_at: string;
}

export type KapiScriptLanguage = 'javascript' | 'shell';

export interface KapiRequest {
  id: string;
  definition_id: string;
  folder_id: string | null;
  name: string;
  method: KapiHttpMethod;
  path: string;
  query_params: KapiKeyValue[];
  headers: KapiKeyValue[];
  body_type: KapiBodyType;
  body_content: string;
  body_language: KapiBodyLanguage;
  auth_override: KapiAuthConfig | null;
  pre_script_content: string;
  pre_script_language: KapiScriptLanguage;
  test_script_content: string;
  test_script_language: KapiScriptLanguage;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface KapiEnvironment {
  id: string;
  collection_id: string;
  handle: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface KapiEnvVar {
  id: string;
  environment_id: string;
  key: string;
  /** Plaintext value for non-secret vars. Null when is_secret. */
  value: string | null;
  is_secret: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface KapiRun {
  id: string;
  collection_id: string;
  request_id: string | null;
  definition_id: string | null;
  environment_id: string | null;
  resolved_method: KapiHttpMethod;
  resolved_url: string;
  resolved_headers: KapiKeyValue[];
  resolved_body: string | null;
  response_status: number | null;
  response_headers: Array<[string, string]> | null;
  response_body: string | null;
  response_time_ms: number | null;
  pre_script_log: string | null;
  test_script_log: string | null;
  pre_script_error: string | null;
  test_script_error: string | null;
  pre_script_env_writes: Record<string, string> | null;
  test_script_env_writes: Record<string, string> | null;
  test_results: Array<{ name: string; pass: boolean; error?: string }> | null;
  error: string | null;
  executed_at: string;
}

import { createClient } from "@supabase/supabase-js";

export interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

let client: any = null;
let cachedEnv: SupabaseEnv | null = null;

export function getSupabase(env: SupabaseEnv): any {
  if (client && cachedEnv === env) return client;
  cachedEnv = env;
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

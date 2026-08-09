export const DEFAULT_MARKET_ORIGIN = "https://xpred.aidenhuang.com";
export const LEGACY_MARKET_ORIGINS = new Set([
  "http://localhost:5175",
]);

export function normalizeMarketOrigin(origin) {
  const normalized = typeof origin === "string" ? origin.trim().replace(/\/$/, "") : "";
  return !normalized || LEGACY_MARKET_ORIGINS.has(normalized)
    ? DEFAULT_MARKET_ORIGIN
    : normalized;
}

export const DEFAULT_SUPABASE_URL = "https://fxoiyujqvfnclobriker.supabase.co";
export const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_b3S00ffqP0mRMMjdDFBzOg_FPjNljlS";

import {
  buyPosition,
  connectWithWebsite,
  getAuthState,
  getMarketPositions,
  resetAuthClient,
  sellPosition,
  signInWithEmail,
  signOut,
  signUpWithEmail,
} from "./auth.js";
import {
  DEFAULT_MARKET_ORIGIN,
  DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SUPABASE_URL,
} from "./config.js";

const responseCache = new Map();
const CACHE_TTL = 30_000;

async function getSettings() {
  const values = await chrome.storage.sync.get({
    marketOrigin: DEFAULT_MARKET_ORIGIN,
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabasePublishableKey: DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  });
  return {
    marketOrigin: values.marketOrigin.replace(/\/$/, ""),
    supabaseUrl: values.supabaseUrl.replace(/\/$/, ""),
    supabasePublishableKey: values.supabasePublishableKey,
  };
}

function normalizeMarket(record, fallbackId) {
  return {
    id: record.slug || fallbackId || record.id,
    question: record.question,
    description: record.description || record.resolution_criteria || "",
    yesPrice: Number(record.yesPrice ?? record.yes_price ?? 0.5),
    volume: Number(record.volume ?? 0),
    traderCount: Number(record.traderCount ?? record.trader_count ?? 0),
    liquidityParameter: Number(record.liquidityParameter ?? record.liquidity_parameter),
    closesAt: record.closesAt ?? record.closes_at,
    status: record.status || "open",
    category: record.category || "Market",
  };
}

async function fetchMarket(marketId) {
  const { marketOrigin, supabaseUrl, supabasePublishableKey } = await getSettings();
  const key = `${supabaseUrl}:${marketId}`;
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) return cached.value;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    const query = new URLSearchParams({
      slug: `eq.${marketId}`,
      select: "id,slug,question,description,resolution_criteria,category,status,yes_price,volume,trader_count,liquidity_parameter,closes_at",
      limit: "1",
    });
    const response = await fetch(`${supabaseUrl}/rest/v1/markets?${query}`, {
      headers: {
        Accept: "application/json",
        apikey: supabasePublishableKey,
        Authorization: `Bearer ${supabasePublishableKey}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`Supabase returned ${response.status}`);
    const records = await response.json();
    if (!records.length) throw new Error(`No market found for slug “${marketId}”.`);
    const market = normalizeMarket(records[0], marketId);
    const value = { market, marketOrigin, source: "supabase" };
    responseCache.set(key, { value, createdAt: Date.now() });
    return value;
  } catch (error) {
    throw new Error(error.name === "AbortError" ? "The Supabase market lookup timed out." : error.message);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const values = await chrome.storage.sync.get([
    "marketOrigin",
    "supabaseUrl",
    "supabasePublishableKey",
  ]);
  await chrome.storage.sync.set({
    marketOrigin: values.marketOrigin || DEFAULT_MARKET_ORIGIN,
    supabaseUrl: values.supabaseUrl || DEFAULT_SUPABASE_URL,
    supabasePublishableKey:
      values.supabasePublishableKey || DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.supabaseUrl || changes.supabasePublishableKey)) {
    resetAuthClient();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SIGNAL_GET_MARKET") {
    fetchMarket(message.marketId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SIGNAL_GET_SETTINGS") {
    getSettings().then((settings) => sendResponse({ ok: true, ...settings }));
    return true;
  }

  if (message?.type === "SIGNAL_GET_AUTH") {
    getAuthState()
      .then((auth) => sendResponse({ ok: true, ...auth }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SIGNAL_GET_MARKET_POSITIONS") {
    getMarketPositions(message.marketSlug)
      .then((positions) => sendResponse({ ok: true, positions }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SIGNAL_CONNECT_WEBSITE") {
    connectWithWebsite()
      .then((user) => sendResponse({ ok: true, user }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SIGNAL_SIGN_IN_EMAIL") {
    signInWithEmail(message.email, message.password)
      .then((user) => sendResponse({ ok: true, user }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SIGNAL_SIGN_UP_EMAIL") {
    signUpWithEmail(message.email, message.password)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SIGNAL_BUY_POSITION") {
    buyPosition({
      marketSlug: message.marketSlug,
      outcome: message.outcome,
      amount: message.amount,
      clientOrderId: message.clientOrderId,
    })
      .then((result) => {
        responseCache.clear();
        sendResponse({ ok: true, result });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SIGNAL_SELL_POSITION") {
    sellPosition({
      marketSlug: message.marketSlug,
      outcome: message.outcome,
      shares: message.shares,
      clientOrderId: message.clientOrderId,
    })
      .then((result) => {
        responseCache.clear();
        sendResponse({ ok: true, result });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SIGNAL_SIGN_OUT") {
    signOut()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

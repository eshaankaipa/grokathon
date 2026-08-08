import { createClient } from "@supabase/supabase-js";
import { DEFAULT_SUPABASE_PUBLISHABLE_KEY, DEFAULT_SUPABASE_URL } from "./config.js";

const AUTH_STORAGE_KEY = "signal-extension-auth";
let cachedClient = null;
let cachedFingerprint = "";

const chromeStorageAdapter = {
  async getItem(key) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  },
  async setItem(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key) {
    await chrome.storage.local.remove(key);
  },
};

async function getAuthConfig() {
  const { supabaseUrl = "", supabasePublishableKey = "" } = await chrome.storage.sync.get({
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabasePublishableKey: DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  });
  return {
    supabaseUrl: supabaseUrl.trim().replace(/\/$/, ""),
    supabasePublishableKey: supabasePublishableKey.trim(),
  };
}

function publicUser(user) {
  if (!user) return null;
  const metadata = user.user_metadata ?? {};
  return {
    id: user.id,
    email: user.email ?? null,
    displayName: metadata.full_name || metadata.name || metadata.user_name || user.email || "xmarket trader",
    xHandle: metadata.user_name || metadata.preferred_username || null,
    avatarUrl: metadata.avatar_url || metadata.picture || null,
  };
}

async function getClient() {
  const config = await getAuthConfig();
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    throw new Error("Supabase URL and publishable key are not configured.");
  }

  const fingerprint = `${config.supabaseUrl}:${config.supabasePublishableKey}`;
  if (cachedClient && cachedFingerprint === fingerprint) return cachedClient;

  cachedFingerprint = fingerprint;
  cachedClient = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: chromeStorageAdapter,
      storageKey: AUTH_STORAGE_KEY,
    },
  });
  return cachedClient;
}

function validateEmailCredentials(email, password) {
  const normalizedEmail = typeof email === "string" ? email.trim() : "";
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new Error("Enter a valid email address.");
  }
  if (typeof password !== "string" || password.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }
  return { email: normalizedEmail, password };
}

export async function getAuthState() {
  const config = await getAuthConfig();
  const configured = Boolean(config.supabaseUrl && config.supabasePublishableKey);
  if (!configured) {
    return { configured: false, user: null };
  }

  const client = await getClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  let balance = null;
  if (data.session?.user) {
    const { data: profile, error: profileError } = await client
      .from("profiles")
      .select("demo_balance")
      .eq("id", data.session.user.id)
      .single();
    if (!profileError) balance = Number(profile.demo_balance);
  }
  return {
    configured: true,
    user: publicUser(data.session?.user),
    balance,
  };
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function connectWithWebsite() {
  const client = await getClient();
  const { marketOrigin = "" } = await chrome.storage.sync.get("marketOrigin");
  if (!marketOrigin) throw new Error("The market website is not configured.");

  const callbackUrl = chrome.identity.getRedirectURL("supabase-auth");
  const state = randomState();
  const connectUrl = new URL("/extension-auth", marketOrigin);
  connectUrl.searchParams.set("redirect_to", callbackUrl);
  connectUrl.searchParams.set("state", state);

  const finalUrl = await chrome.identity.launchWebAuthFlow({
    url: connectUrl.toString(),
    interactive: true,
  });
  if (!finalUrl) throw new Error("The website connection window was closed.");

  const callback = new URL(finalUrl);
  const expectedCallback = new URL(callbackUrl);
  if (callback.origin !== expectedCallback.origin || callback.pathname !== expectedCallback.pathname) {
    throw new Error("The website returned an invalid extension callback.");
  }
  if (callback.searchParams.get("state") !== state) {
    throw new Error("The website connection response could not be verified.");
  }
  const callbackError = callback.searchParams.get("error");
  if (callbackError) throw new Error(callbackError);
  const tokenHash = callback.searchParams.get("token_hash");
  const tokenType = callback.searchParams.get("token_type");
  if (!tokenHash || tokenType !== "magiclink") {
    throw new Error("The website did not return a valid connection token.");
  }

  const { data, error } = await client.auth.verifyOtp({
    token_hash: tokenHash,
    type: tokenType,
  });
  if (error) throw error;
  return publicUser(data.user);
}

export async function signInWithEmail(email, password) {
  const client = await getClient();
  const credentials = validateEmailCredentials(email, password);
  const { data, error } = await client.auth.signInWithPassword(credentials);
  if (error) throw error;
  return publicUser(data.user);
}

export async function signUpWithEmail(email, password) {
  const client = await getClient();
  const credentials = validateEmailCredentials(email, password);
  const { data, error } = await client.auth.signUp(credentials);
  if (error) throw error;
  return {
    user: publicUser(data.user),
    confirmationRequired: !data.session,
  };
}

export async function buyPosition({ marketSlug, outcome, amount, clientOrderId }) {
  const client = await getClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) throw new Error("Connect your xmarket account before trading.");

  const { data, error } = await client.rpc("buy_market_position", {
    p_market_slug: marketSlug,
    p_outcome: outcome,
    p_amount: amount,
    p_client_order_id: clientOrderId,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const client = await getClient();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

export function resetAuthClient() {
  cachedClient = null;
  cachedFingerprint = "";
}

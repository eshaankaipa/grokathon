import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = { "Content-Type": "application/json" };

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "http://localhost:5175",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function allowedOrigin(requestOrigin: string | null, configuredSiteUrl: string) {
  if (!requestOrigin) return configuredSiteUrl;

  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(requestOrigin);
  const configuredOrigin = new URL(configuredSiteUrl).origin;
  return isLocal || requestOrigin === configuredOrigin ? requestOrigin : configuredOrigin;
}

Deno.serve(async (request) => {
  const configuredSiteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:5175";
  const origin = allowedOrigin(request.headers.get("Origin"), configuredSiteUrl);
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...jsonHeaders, ...cors },
    });
  }

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!stripeSecretKey || !supabaseUrl || !serviceRoleKey) {
      throw new Error("Server payment configuration is incomplete");
    }

    const authorization = request.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Sign in before checking out" }), {
        status: 401,
        headers: { ...jsonHeaders, ...cors },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const token = authorization.slice("Bearer ".length);
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) {
      return new Response(JSON.stringify({ error: "Your session has expired. Please sign in again." }), {
        status: 401,
        headers: { ...jsonHeaders, ...cors },
      });
    }

    const body = await request.json();
    const amount = Number(body.amount);
    const amountCents = Math.round(amount * 100);
    const allowedAmounts = new Set([5, 10, 25, 50, 100]);

    if (!Number.isFinite(amount) || !allowedAmounts.has(amount)) {
      return new Response(JSON.stringify({ error: "Choose a supported credit pack." }), {
        status: 400,
        headers: { ...jsonHeaders, ...cors },
      });
    }
    const credits = amountCents;
    const stripeBody = new URLSearchParams({
      mode: "payment",
      submit_type: "pay",
      success_url: `${origin}/credits/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/credits/cancel`,
      client_reference_id: authData.user.id,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": amountCents.toString(),
      "line_items[0][price_data][product_data][name]": `${credits.toLocaleString()} xmarket credits`,
      "line_items[0][price_data][product_data][description]": "Credits for prediction-market trading.",
      "metadata[user_id]": authData.user.id,
      "metadata[usd_amount]": (amountCents / 100).toFixed(2),
      "metadata[credits]": credits.toString(),
    });

    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: stripeBody,
    });
    const stripeSession = await stripeResponse.json();

    if (!stripeResponse.ok || !stripeSession.url) {
      console.error("Stripe Checkout Session creation failed", stripeSession?.error?.type);
      throw new Error(stripeSession?.error?.message ?? "Stripe could not start checkout");
    }

    return new Response(JSON.stringify({ url: stripeSession.url }), {
      status: 200,
      headers: { ...jsonHeaders, ...cors },
    });
  } catch (error) {
    console.error("create-checkout-session", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Checkout failed" }), {
      status: 500,
      headers: { ...jsonHeaders, ...cors },
    });
  }
});

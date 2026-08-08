import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();

function parseStripeSignature(header: string) {
  const values = header.split(",").map((part) => part.trim().split("=", 2));
  const timestamp = values.find(([key]) => key === "t")?.[1];
  const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value);
  return { timestamp, signatures };
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function expectedSignature(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeSignature(body: string, header: string, secret: string) {
  const { timestamp, signatures } = parseStripeSignature(header);
  if (!timestamp || signatures.length === 0) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return false;
  }

  const expected = await expectedSignature(secret, `${timestamp}.${body}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!webhookSecret || !supabaseUrl || !serviceRoleKey) {
    console.error("Stripe webhook server configuration is incomplete");
    return new Response("Server configuration error", { status: 500 });
  }

  const body = await request.text();
  const signatureHeader = request.headers.get("Stripe-Signature");
  if (!signatureHeader || !(await verifyStripeSignature(body, signatureHeader, webhookSecret))) {
    return new Response("Invalid Stripe signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return new Response("Event ignored", { status: 200 });
  }

  const session = event.data?.object;
  const metadata = session?.metadata ?? {};
  const usdAmount = Number(metadata.usd_amount);
  const amountCents = Math.round(usdAmount * 100);
  const credits = Number(metadata.credits);

  if (
    session?.payment_status !== "paid" ||
    session?.currency !== "usd" ||
    session?.amount_total !== amountCents ||
    !metadata.user_id ||
    !Number.isFinite(usdAmount) ||
    !Number.isFinite(credits) ||
    credits !== amountCents ||
    usdAmount < 5 ||
    usdAmount > 100
  ) {
    console.error("Stripe session had invalid purchase metadata", session?.id);
    return new Response("Invalid checkout metadata", { status: 400 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.rpc("complete_stripe_credit_purchase", {
    p_stripe_checkout_session_id: session.id,
    p_user_id: metadata.user_id,
    p_usd_amount: usdAmount,
    p_credits: credits,
  });

  if (error) {
    console.error("Could not persist completed Stripe purchase", error.code, error.message);
    return new Response("Could not persist purchase", { status: 500 });
  }

  return new Response("Purchase recorded", { status: 200 });
});

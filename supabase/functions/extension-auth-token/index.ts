import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
    ? origin
    : Deno.env.get("SITE_URL") ?? "http://localhost:5175";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request.headers.get("Origin"));
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = request.headers.get("Authorization");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Server auth configuration is incomplete.");
    if (!authorization?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Sign in on the website before connecting the extension." }), {
        status: 401,
        headers: { ...jsonHeaders, ...cors },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const accessToken = authorization.slice("Bearer ".length);
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    const email = userData.user?.email;
    if (userError || !email) {
      return new Response(JSON.stringify({ error: "Your website session has expired. Please sign in again." }), {
        status: 401,
        headers: { ...jsonHeaders, ...cors },
      });
    }

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    const tokenHash = linkData?.properties?.hashed_token;
    if (linkError || !tokenHash) throw linkError ?? new Error("Supabase did not issue a connection token.");

    return new Response(JSON.stringify({
      tokenHash,
      tokenType: linkData.properties.verification_type,
    }), {
      status: 200,
      headers: { ...jsonHeaders, ...cors },
    });
  } catch (error) {
    console.error("extension-auth-token", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Could not connect the extension.",
    }), {
      status: 500,
      headers: { ...jsonHeaders, ...cors },
    });
  }
});

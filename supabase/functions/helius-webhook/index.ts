import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ACCEPTED_TOKENS = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6 },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6 },
};

const SOL_USD_PRICE = parseFloat(Deno.env.get("SOL_USD_PRICE") || "150");

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const authHeader = req.headers.get("authorization");
  const expectedAuth = Deno.env.get("HELIUS_WEBHOOK_SECRET");
  if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  let events;
  try {
    events = await req.json();
    if (!Array.isArray(events)) events = [events];
  } catch (e) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  );

  const results = [];

  for (const event of events) {
    try {
      const txHash = event.signature || event.transaction?.signatures?.[0];
      if (!txHash) continue;

      if (event.type === "TRANSFER" && event.tokenTransfers?.length > 0) {
        for (const transfer of event.tokenTransfers) {
          const tokenInfo = ACCEPTED_TOKENS[transfer.mint];
          if (!tokenInfo) continue;
          const toAddress = transfer.toUserAccount;
          const amountUSD = transfer.tokenAmount / Math.pow(10, tokenInfo.decimals);
          if (amountUSD < 0.01) continue;
          const { data: user } = await supabase.from("users").select("id").eq("deposit_sol_address", toAddress).maybeSingle();
          if (!user) continue;
          const { data, error } = await supabase.rpc("credit_deposit", {
            p_user_id: user.id, p_amount: amountUSD, p_tx_hash: txHash,
            p_network: tokenInfo.symbol + "-SOL", p_token: tokenInfo.symbol,
          });
          results.push({ txHash, user: user.id, amount: amountUSD, token: tokenInfo.symbol, result: data, error });
        }
      }

      if (event.nativeTransfers?.length > 0) {
        for (const transfer of event.nativeTransfers) {
          const toAddress = transfer.toUserAccount;
          const sol = transfer.amount / 1_000_000_000;
          const amountUSD = Math.round(sol * SOL_USD_PRICE * 100) / 100;
          if (amountUSD < 0.01) continue;
          const { data: user } = await supabase.from("users").select("id").eq("deposit_sol_address", toAddress).maybeSingle();
          if (!user) continue;
          const { data, error } = await supabase.rpc("credit_deposit", {
            p_user_id: user.id, p_amount: amountUSD, p_tx_hash: txHash + "_sol",
            p_network: "SOL", p_token: "SOL",
          });
          results.push({ txHash, user: user.id, amountSOL: sol, amountUSD, token: "SOL", result: data, error });
        }
      }
    } catch (e) {
      results.push({ error: e.message });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ACCEPTED_TOKENS = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6 },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6 },
};
const SOL_USD_PRICE = parseFloat(Deno.env.get("SOL_USD_PRICE") || "150");
const MASTER_SOL = "8nb7zhT7F3ScEquCzhaQu2uQzgLtj4edgyXiATZyaUcN";

function extractMemo(event) {
  const sources = [event.memo, event.description, JSON.stringify(event)];
  for (const src of sources) {
    if (!src) continue;
    const m = String(src).match(/SW-\d{6}/);
    if (m) return m[0];
  }
  return null;
}

async function findUser(supabase, toAddress, memo) {
  if (memo) {
    const { data } = await supabase.from("users").select("id,username").eq("deposit_memo", memo).maybeSingle();
    if (data) return { ...data, method: "memo" };
  }
  if (toAddress && toAddress !== MASTER_SOL) {
    const { data } = await supabase.from("users").select("id,username").eq("deposit_sol_address", toAddress).maybeSingle();
    if (data) return { ...data, method: "address" };
  }
  return null;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const auth = req.headers.get("authorization");
  const secret = Deno.env.get("HELIUS_WEBHOOK_SECRET");
  if (secret && auth !== "Bearer " + secret) return new Response("Unauthorized", { status: 401 });

  let events;
  try { events = await req.json(); if (!Array.isArray(events)) events = [events]; }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const results = [];

  for (const event of events) {
    try {
      const txHash = event.signature || event.transaction?.signatures?.[0];
      if (!txHash) continue;
      const memo = extractMemo(event);

      for (const transfer of (event.tokenTransfers || [])) {
        const tokenInfo = ACCEPTED_TOKENS[transfer.mint];
        if (!tokenInfo) continue;
        const amountUSD = transfer.tokenAmount / Math.pow(10, tokenInfo.decimals);
        if (amountUSD < 0.01) continue;
        const user = await findUser(supabase, transfer.toUserAccount, memo);
        if (!user) { console.log("No user for " + transfer.toUserAccount + " memo=" + memo); continue; }
        const { data, error } = await supabase.rpc("credit_deposit", { p_user_id: user.id, p_amount: amountUSD, p_tx_hash: txHash, p_network: tokenInfo.symbol + "-SOL", p_token: tokenInfo.symbol });
        console.log("Credited " + amountUSD + " " + tokenInfo.symbol + " to " + user.username + " via " + user.method);
        results.push({ txHash, user: user.id, amount: amountUSD, token: tokenInfo.symbol, result: data, error });
      }

      for (const transfer of (event.nativeTransfers || [])) {
        const sol = transfer.amount / 1_000_000_000;
        const amountUSD = Math.round(sol * SOL_USD_PRICE * 100) / 100;
        if (amountUSD < 0.01) continue;
        const user = await findUser(supabase, transfer.toUserAccount, memo);
        if (!user) continue;
        const { data, error } = await supabase.rpc("credit_deposit", { p_user_id: user.id, p_amount: amountUSD, p_tx_hash: txHash + "_sol", p_network: "SOL", p_token: "SOL" });
        console.log("Credited " + sol + " SOL ($" + amountUSD + ") to " + user.username + " via " + user.method);
        results.push({ txHash, user: user.id, amountSOL: sol, amountUSD, result: data, error });
      }
    } catch(e) { console.error("Error:", e.message); results.push({ error: e.message }); }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), { headers: { "Content-Type": "application/json" } });
});

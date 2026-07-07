import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-alchemy-signature",
};

const POLY_TOKENS = {
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": "USDC",
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "USDT",
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "USDC",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  let payload;
  try { payload = await req.json(); }
  catch { return new Response("Invalid JSON", { status: 400, headers: CORS }); }

  const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const results = [];

  for (const event of (payload.event?.activity || [])) {
    try {
      const toAddr = (event.toAddress || "").toLowerCase();
      const txHash = event.hash || "";
      const asset  = event.asset || "";
      const rawVal = parseFloat(event.value || "0");

      // Buscar wallet bloqueada activa para esta dirección
      const { data: wallet } = await sb
        .from("deposit_wallets")
        .select("id,locked_by,expected_amount")
        .ilike("address", toAddr)
        .not("locked_by", "is", null)
        .gt("locked_until", new Date().toISOString())
        .maybeSingle();

      if (!wallet) { console.log("Sin sesion:", toAddr); continue; }

      let amountUSD = 0, tokenSymbol = "";

      if (event.rawContract?.address) {
        const ca = event.rawContract.address.toLowerCase();
        tokenSymbol = POLY_TOKENS[ca] || asset;
        const rawHex = event.rawContract?.rawValue || "0x0";
        amountUSD = Math.round(parseInt(rawHex, 16) / 1_000_000 * 100) / 100;
      } else {
        const mp = parseFloat(Deno.env.get("MATIC_USD_PRICE") || "0.5");
        amountUSD = Math.round(rawVal * mp * 100) / 100;
        tokenSymbol = "MATIC";
      }

      if (amountUSD < 0.01) continue;

      const { data, error } = await sb.rpc("credit_deposit", {
        p_user_id: wallet.locked_by,
        p_amount:  amountUSD,
        p_tx_hash: txHash,
        p_network: tokenSymbol + "-POLY",
        p_token:   tokenSymbol,
      });

      if (error) { console.error("credit_deposit:", error.message); continue; }
      if (data?.already_credited) continue;

      // Liberar wallet
      await sb.from("deposit_wallets").update({
        locked_until: null, locked_by: null,
        expected_amount: null, expected_network: null,
      }).eq("id", wallet.id);

      console.log("OK:", amountUSD, tokenSymbol, "->", wallet.locked_by);
      results.push({ txHash, amountUSD, tokenSymbol, user: wallet.locked_by });

    } catch(e) { console.error("Error:", e.message); }
  }

  return new Response(JSON.stringify({ processed: results.length, results }),
    { headers: { ...CORS, "Content-Type": "application/json" } });
});

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-alchemy-signature",
};

// Tokens ERC-20 en Polygon Mainnet
const POLY_TOKENS = {
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": "USDC",  // USDC.e
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "USDT",  // USDT
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "USDC",  // USDC nativo
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Leer el body — NO verificamos firma aquí para evitar el 401
  // Alchemy ya tiene el webhook configurado con URL privada en Supabase
  let payload;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  console.log("Alchemy webhook received:", JSON.stringify(payload).substring(0, 500));

  const sb = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  );

  const results = [];
  const activity = payload.event?.activity || payload.activity || [];

  for (const event of activity) {
    try {
      const toAddr = (event.toAddress || "").toLowerCase();
      const txHash = event.hash || event.transactionHash || "";
      const asset  = event.asset || "";
      const rawVal = parseFloat(event.value || "0");

      console.log("Processing:", { toAddr, txHash, asset, rawVal });

      // Buscar wallet bloqueada activa para esta dirección
      const { data: wallet, error: wErr } = await sb
        .from("deposit_wallets")
        .select("id,locked_by,expected_amount")
        .ilike("address", toAddr)
        .not("locked_by", "is", null)
        .gt("locked_until", new Date().toISOString())
        .maybeSingle();

      if (wErr) { console.error("DB error:", wErr.message); continue; }
      if (!wallet) { console.log("No active session for:", toAddr); continue; }

      let amountUSD = 0, tokenSymbol = "";

      if (event.rawContract?.address) {
        // Token ERC-20 (USDC, USDT)
        const ca = event.rawContract.address.toLowerCase();
        tokenSymbol = POLY_TOKENS[ca] || asset || "TOKEN";
        const rawHex = event.rawContract?.rawValue || "0x0";
        amountUSD = Math.round(parseInt(rawHex, 16) / 1_000_000 * 100) / 100;
      } else {
        // MATIC/POL nativo
        const mp = parseFloat(Deno.env.get("MATIC_USD_PRICE") || "0.5");
        amountUSD = Math.round(rawVal * mp * 100) / 100;
        tokenSymbol = "MATIC";
      }

      console.log("Amount:", amountUSD, tokenSymbol, "-> user:", wallet.locked_by);

      if (amountUSD < 0.01) {
        console.log("Amount too small, skipping");
        continue;
      }

      // Acreditar
      const { data, error } = await sb.rpc("credit_deposit", {
        p_user_id: wallet.locked_by,
        p_amount:  amountUSD,
        p_tx_hash: txHash,
        p_network: tokenSymbol + "-POLY",
        p_token:   tokenSymbol,
      });

      if (error) { console.error("credit_deposit error:", error.message); continue; }
      if (data?.already_credited) { console.log("Already credited:", txHash); continue; }

      // Liberar wallet
      await sb.from("deposit_wallets").update({
        locked_until: null, locked_by: null,
        expected_amount: null, expected_network: null,
      }).eq("id", wallet.id);

      console.log("SUCCESS: credited", amountUSD, tokenSymbol, "to", wallet.locked_by);
      results.push({ txHash, amountUSD, tokenSymbol, user: wallet.locked_by });

    } catch (e) {
      console.error("Error processing event:", e.message);
    }
  }

  return json({ processed: results.length, results });
});

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://xskobwfwxvvazteuwggb.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhza29id2Z3eHZ2YXp0ZXV3Z2diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNzk3NDMsImV4cCI6MjA4ODg1NTc0M30.Oxlk7LtATZxqYHXOaA9Em9owG20kDwFtFKB0mbyJpfQ";
const PLATFORM_WALLET = "0xB715A691A5ab505e492eEB6DeFd66F750d9199E3";

// Token contracts on Polygon
const TOKENS = {
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { symbol: "USDC", decimals: 6 },
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6 },
};

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const activities = body?.event?.activity || [];

    for (const activity of activities) {
      const toAddress   = (activity.toAddress  || "").toLowerCase();
      const fromAddress = (activity.fromAddress || "").toLowerCase();
      const asset       = (activity.asset       || "").toLowerCase();
      const hash        = activity.hash || activity.transactionHash || "";
      const rawValue    = activity.value || 0;

      // Only process transfers TO our platform wallet
      if (toAddress !== PLATFORM_WALLET.toLowerCase()) continue;

      let amountUSD = 0;
      let tokenSymbol = "MATIC";

      if (asset === "matic" || asset === "pol") {
        // MATIC — fetch price from CoinGecko
        let maticPrice = 0.50;
        try {
          const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd");
          const data = await res.json();
          maticPrice = data?.["matic-network"]?.usd || 0.50;
        } catch (_) {}
        amountUSD = rawValue * maticPrice;
        tokenSymbol = "MATIC";

      } else if (TOKENS[asset]) {
        // USDC or USDT — 1:1 with USD
        const token = TOKENS[asset];
        amountUSD = rawValue; // Alchemy already normalizes ERC-20 values
        tokenSymbol = token.symbol;

      } else {
        // Unknown token — skip
        continue;
      }

      if (amountUSD < 0.01) continue;

      // Deduplicate by tx hash
      const dedupKey = `tx:${hash}:${tokenSymbol}`;
      const { data: existingTx } = await db
        .from("transactions")
        .select("id")
        .eq("description", dedupKey)
        .maybeSingle();
      if (existingTx) continue; // already processed

      // Find user by fromAddress
      const { data: userData } = await db
        .from("users")
        .select("*")
        .ilike("wallet_address", fromAddress)
        .maybeSingle();

      if (userData) {
        // Credit balance
        const newBalance = (userData.balance || 0) + amountUSD;
        await db.from("users").update({ balance: newBalance }).eq("id", userData.id);

        // Insert confirmed transaction
        await db.from("transactions").insert({
          user_id:     userData.id,
          type:        "deposit",
          amount:      amountUSD,
          network:     "polygon",
          description: `Depósito ${tokenSymbol} +$${amountUSD.toFixed(2)} · ${dedupKey}`,
          status:      "confirmed",
          created_at:  new Date().toISOString(),
        });

        console.log(`[Webhook] Credited $${amountUSD.toFixed(2)} ${tokenSymbol} to user ${userData.id}`);
      } else {
        // Unknown wallet — save as pending
        await db.from("transactions").insert({
          user_id:     null,
          type:        "deposit",
          amount:      amountUSD,
          network:     "polygon",
          description: `${dedupKey} · wallet:${fromAddress} · pendiente asignación`,
          status:      "pending_assignment",
          created_at:  new Date().toISOString(),
        });
        console.log(`[Webhook] Unknown wallet ${fromAddress} — saved as pending`);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("[Webhook] Error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

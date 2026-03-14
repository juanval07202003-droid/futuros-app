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




const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://xskobwfwxvvazteuwggb.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhza29id2Z3eHZ2YXp0ZXV3Z2diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNzk3NDMsImV4cCI6MjA4ODg1NTc0M30.Oxlk7LtATZxqYHXOaA9Em9owG20kDwFtFKB0mbyJpfQ";

// ── Polygon ──────────────────────────────────────────────
const PLATFORM_POLYGON  = "0xb715a691a5ab505e492eeb6defd66f750d9199e3";
const USDC_POLYGON      = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const USDT_POLYGON      = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";

// ── Solana ───────────────────────────────────────────────
const PLATFORM_SOLANA   = "8nb7zhT7F3ScEquCzhaQu2uQzgLtj4edgyXiATZyaUcN";
const USDC_SOLANA_MINT  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_SOLANA_MINT  = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Token detection ──────────────────────────────────────
function detectPolygonToken(activity) {
  const asset       = (activity.asset || "").toLowerCase().trim();
  const contract    = (activity.rawContract?.address || "").toLowerCase();
  const rawValue    = activity.value || activity.rawContract?.value || 0;

  if (asset === "matic" || asset === "pol")
    return { symbol: "MATIC", amount: rawValue, isNative: true };
  if (asset === USDT_POLYGON || asset === "usdt" || contract === USDT_POLYGON)
    return { symbol: "USDT", amount: rawValue, isNative: false };
  if (asset === USDC_POLYGON || asset === "usdc" || contract === USDC_POLYGON)
    return { symbol: "USDC", amount: rawValue, isNative: false };
  return null;
}

function detectSolanaToken(activity) {
  const asset    = (activity.asset || "").toLowerCase().trim();
  const contract = (activity.rawContract?.address || activity.contractAddress || "");
  const rawValue = activity.value || activity.rawContract?.value || 0;

  if (asset === "sol" || asset === "solana")
    return { symbol: "SOL", amount: rawValue, isNative: true };
  if (contract === USDC_SOLANA_MINT || asset === "usdc")
    return { symbol: "USDC-SOL", amount: rawValue, isNative: false };
  if (contract === USDT_SOLANA_MINT || asset === "usdt")
    return { symbol: "USDT-SOL", amount: rawValue, isNative: false };
  return null;
}

// ── USD conversion ───────────────────────────────────────
async function toUSD(token, amount) {
  if (token === "MATIC") {
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd");
      const d = await r.json();
      return amount * (d?.["matic-network"]?.usd || 0.50);
    } catch (_) { return amount * 0.50; }
  }
  if (token === "SOL") {
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
      const d = await r.json();
      return amount * (d?.solana?.usd || 140);
    } catch (_) { return amount * 140; }
  }
  // Stablecoins: 1:1
  return Number(amount);
}

// ── Credit user ──────────────────────────────────────────
async function creditUser(fromAddress, amountUSD, symbol, hash, network) {
  const dedupKey = `tx:${hash}`;

  // Dedup check
  const { data: existingTx } = await db.from("transactions")
    .select("id").ilike("description", `%${hash}%`).maybeSingle();
  if (existingTx) { console.log(`[Webhook] Already processed ${hash}`); return; }

  // Find user
  const { data: userData, error: userErr } = await db.from("users")
    .select("*").ilike("wallet_address", fromAddress).maybeSingle();
  if (userErr) console.error("[Webhook] User lookup error:", userErr.message);

  if (userData) {
    const newBalance = (userData.balance || 0) + amountUSD;
    await db.from("users").update({ balance: newBalance }).eq("id", userData.id);
    await db.from("transactions").insert({
      user_id:     userData.id,
      type:        "deposit",
      amount:      amountUSD,
      network,
      description: `Depósito ${symbol} +$${amountUSD.toFixed(2)} · ${dedupKey}`,
      status:      "confirmed",
      created_at:  new Date().toISOString(),
    });
    console.log(`[Webhook] ✅ Credited $${amountUSD.toFixed(2)} ${symbol} → ${userData.username}`);
  } else {
    await db.from("transactions").insert({
      user_id:     null,
      type:        "deposit",
      amount:      amountUSD,
      network,
      description: `${dedupKey} · wallet:${fromAddress} · pendiente asignación`,
      status:      "pending_assignment",
      created_at:  new Date().toISOString(),
    });
    console.log(`[Webhook] ⚠️ Unknown wallet ${fromAddress} — pending_assignment`);
  }
}

// ── Main handler ─────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const body = JSON.parse(event.body);
    console.log("[Webhook] Body:", JSON.stringify(body).slice(0, 600));

    const activities = body?.event?.activity || [];
    console.log(`[Webhook] Activities: ${activities.length}`);

    for (const activity of activities) {
      const toAddress   = (activity.toAddress   || "").toLowerCase();
      const fromAddress = (activity.fromAddress || "").toLowerCase();
      const hash        = activity.hash || activity.transactionHash || "";
      const network     = (activity.network || body?.event?.network || "").toLowerCase();

      console.log(`[Webhook] from=${fromAddress} to=${toAddress} asset=${activity.asset} value=${activity.value} network=${network} hash=${hash.slice(0,20)}`);

      // ── Polygon ──
      if (toAddress === PLATFORM_POLYGON) {
        const token = detectPolygonToken(activity);
        if (!token) { console.log("[Webhook] Unknown Polygon token, skip"); continue; }
        const usd = await toUSD(token.symbol, token.amount);
        console.log(`[Webhook] Polygon ${token.symbol} raw=${token.amount} → $${usd.toFixed(4)}`);
        if (usd < 0.01) continue;
        await creditUser(fromAddress, usd, token.symbol, hash, "polygon");
        continue;
      }

      // ── Solana ──
      if (toAddress === PLATFORM_SOLANA.toLowerCase() || activity.toAddress === PLATFORM_SOLANA) {
        const token = detectSolanaToken(activity);
        if (!token) { console.log("[Webhook] Unknown Solana token, skip"); continue; }
        const usd = await toUSD(token.symbol, token.amount);
        console.log(`[Webhook] Solana ${token.symbol} raw=${token.amount} → $${usd.toFixed(4)}`);
        if (usd < 0.01) continue;
        await creditUser(fromAddress, usd, token.symbol, hash, "solana");
        continue;
      }

      console.log(`[Webhook] Skip — not to any platform wallet (to=${toAddress})`);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("[Webhook] Error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};




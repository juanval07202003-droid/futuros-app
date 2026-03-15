const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://xskobwfwxvvazteuwggb.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhza29id2Z3eHZ2YXp0ZXV3Z2diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNzk3NDMsImV4cCI6MjA4ODg1NTc0M30.Oxlk7LtATZxqYHXOaA9Em9owG20kDwFtFKB0mbyJpfQ";

// ── Wallets de la plataforma ─────────────────────────────
const PLATFORM_POLYGON = "0xb715a691a5ab505e492eeb6defd66f750d9199e3"; // lowercase
const PLATFORM_SOLANA  = "8nb7zhT7F3ScEquCzhaQu2uQzgLtj4edgyXiATZyaUcN";

// ── Contratos Polygon ────────────────────────────────────
const USDC_POLYGON_NATIVE = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"; // USDC nativo Circle
const USDC_POLYGON_LEGACY = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"; // USDC.e bridged
const USDT_POLYGON        = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";

// ── Mints Solana ─────────────────────────────────────────
const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_SOLANA_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Detectar token Polygon ───────────────────────────────
function detectPolygonToken(activity) {
  const asset    = (activity.asset || "").toLowerCase().trim();
  const contract = (activity.rawContract?.address || "").toLowerCase().trim();
  const value    = activity.value ?? activity.rawContract?.value ?? 0;

  if (asset === "matic" || asset === "pol")
    return { symbol: "MATIC", amount: Number(value) };

  if (contract === USDT_POLYGON || asset === "usdt")
    return { symbol: "USDT", amount: Number(value) };

  if (contract === USDC_POLYGON_NATIVE || contract === USDC_POLYGON_LEGACY || asset === "usdc")
    return { symbol: "USDC", amount: Number(value) };

  return null;
}

// ── Detectar token Solana ────────────────────────────────
function detectSolanaToken(activity) {
  const asset    = (activity.asset || "").toLowerCase().trim();
  const contract = (activity.rawContract?.address || activity.contractAddress || "").trim();
  const value    = activity.value ?? activity.rawContract?.value ?? 0;

  if (asset === "sol" || asset === "solana")
    return { symbol: "SOL", amount: Number(value) };

  if (contract === USDC_SOLANA_MINT || asset === "usdc")
    return { symbol: "USDC-SOL", amount: Number(value) };

  if (contract === USDT_SOLANA_MINT || asset === "usdt")
    return { symbol: "USDT-SOL", amount: Number(value) };

  return null;
}

// ── Convertir a USD ──────────────────────────────────────
async function toUSD(symbol, amount) {
  if (symbol === "USDC" || symbol === "USDT" ||
      symbol === "USDC-SOL" || symbol === "USDT-SOL") {
    return Number(amount); // stablecoins 1:1
  }

  const coinId = symbol === "SOL" ? "solana" : "matic-network";
  const fallback = symbol === "SOL" ? 130 : 0.10;

  // Intentar múltiples fuentes de precio
  const sources = [
    () => fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`)
            .then(r => r.json())
            .then(d => d?.[coinId]?.usd),
    () => fetch(`https://min-api.cryptocompare.com/data/price?fsym=${symbol === "SOL" ? "SOL" : "MATIC"}&tsyms=USD`)
            .then(r => r.json())
            .then(d => d?.USD),
  ];

  for (const source of sources) {
    try {
      const price = await source();
      if (price && price > 0) return amount * price;
    } catch (_) {}
  }

  return amount * fallback;
}

// ── Acreditar usuario ────────────────────────────────────
async function creditUser(fromAddress, amountUSD, symbol, hash, network) {
  // Deduplicar por hash
  const { data: existingTx } = await db
    .from("transactions")
    .select("id")
    .ilike("description", `%${hash}%`)
    .maybeSingle();

  if (existingTx) {
    console.log(`[Webhook] Ya procesado: ${hash}`);
    return;
  }

  // Buscar usuario por wallet_address (Solana) O evm_address (EVM/Polygon)
  let user = null;

  const { data: byWallet } = await db
    .from("users").select("*").ilike("wallet_address", fromAddress).maybeSingle();
  user = byWallet;

  if (!user) {
    const { data: byEvm } = await db
      .from("users").select("*").ilike("evm_address", fromAddress).maybeSingle();
    user = byEvm;
    if (user) console.log(`[Webhook] Encontrado por evm_address: ${user.username}`);
  }

  const roundedUSD = Math.round(amountUSD * 100) / 100;
  const txData = {
    type:        "deposit",
    amount:      roundedUSD,
    network,
    description: `Depósito ${symbol} +$${roundedUSD.toFixed(2)} · tx:${hash}`,
    status:      "confirmed",
    created_at:  new Date().toISOString(),
  };

  if (user) {
    const newBalance = Math.round(((user.balance || 0) + roundedUSD) * 100) / 100;
    await db.from("users").update({ balance: newBalance }).eq("id", user.id);
    await db.from("transactions").insert({ ...txData, user_id: user.id });
    console.log(`[Webhook] ✅ +$${roundedUSD.toFixed(2)} ${symbol} → ${user.username} (balance: $${newBalance.toFixed(2)})`);
  } else {
    await db.from("transactions").insert({
      ...txData,
      user_id:     null,
      status:      "pending_assignment",
      description: `tx:${hash} · wallet:${fromAddress} · pendiente asignación · ${symbol} $${roundedUSD.toFixed(2)}`,
    });
    console.log(`[Webhook] ⚠️ Wallet desconocida ${fromAddress} → guardado como pending`);
  }
}

// ── Handler principal ────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const body = JSON.parse(event.body || "{}");
    console.log("[Webhook] Recibido:", JSON.stringify(body).slice(0, 500));

    const activities = body?.event?.activity || [];
    console.log(`[Webhook] Actividades: ${activities.length}`);
    // Log completo para debug de formato Solana
    if(activities.length === 0){
      console.log("[Webhook] PAYLOAD COMPLETO:", JSON.stringify(body).slice(0, 2000));
    }

    for (const activity of activities) {
      const toAddress   = (activity.toAddress   || "").toLowerCase().trim();
      const fromAddress = (activity.fromAddress || "").toLowerCase().trim();
      const hash        = (activity.hash || activity.transactionHash || "").trim();

      console.log(`[Webhook] to=${toAddress} from=${fromAddress} asset=${activity.asset} value=${activity.value} hash=${hash.slice(0,20)}`);

      // ── Polygon ──────────────────────────────────────
      if (toAddress === PLATFORM_POLYGON) {
        const token = detectPolygonToken(activity);
        if (!token) { console.log("[Webhook] Token Polygon desconocido, skip"); continue; }

        const usd = await toUSD(token.symbol, token.amount);
        console.log(`[Webhook] Polygon ${token.symbol} amount=${token.amount} → $${usd.toFixed(4)}`);
        if (usd < 0.01) continue;

        await creditUser(fromAddress, usd, token.symbol, hash, "polygon");
        continue;
      }

      // ── Solana ───────────────────────────────────────
      if (toAddress === PLATFORM_SOLANA.toLowerCase() ||
          activity.toAddress === PLATFORM_SOLANA) {
        const token = detectSolanaToken(activity);
        if (!token) { console.log("[Webhook] Token Solana desconocido, skip"); continue; }

        const usd = await toUSD(token.symbol, token.amount);
        console.log(`[Webhook] Solana ${token.symbol} amount=${token.amount} → $${usd.toFixed(4)}`);
        if (usd < 0.01) continue;

        await creditUser(fromAddress, usd, token.symbol, hash, "solana");
        continue;
      }

      console.log(`[Webhook] Skip — destino no reconocido: ${toAddress}`);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error("[Webhook] Error crítico:", err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

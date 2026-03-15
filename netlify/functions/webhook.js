const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://xskobwfwxvvazteuwggb.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhza29id2Z3eHZ2YXp0ZXV3Z2diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNzk3NDMsImV4cCI6MjA4ODg1NTc0M30.Oxlk7LtATZxqYHXOaA9Em9owG20kDwFtFKB0mbyJpfQ";

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
  const maxReasonable = symbol === "SOL" ? 10000 : 100; // sanity cap

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
      if (price && price > 0 && price < maxReasonable) return amount * price;
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

  // Cap máximo por transacción — previene errores de precio y ataques
  if (amountUSD > 50000) {
    console.warn(`[Webhook] Monto excesivo $${amountUSD} — rechazado`);
    return;
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

  // ── Validar tamaño del payload (max 1MB) ─────────────────────
  const bodySize = Buffer.byteLength(event.body || "", "utf8");
  if (bodySize > 1024 * 1024) {
    console.warn("[Webhook] Payload demasiado grande:", bodySize);
    return { statusCode: 413, body: "Payload Too Large" };
  }

  // ── Verificar que viene de Alchemy (signing key) ──────────────
  // Si tienes el signing key de Alchemy, descomenta y configura:
  // const signingKey = process.env.ALCHEMY_SIGNING_KEY;
  // if (signingKey) {
  //   const signature = event.headers["x-alchemy-signature"] || "";
  //   const hmac = require("crypto").createHmac("sha256", signingKey);
  //   const expected = hmac.update(event.body).digest("hex");
  //   if (signature !== expected) {
  //     console.warn("[Webhook] Firma inválida — posible ataque");
  //     return { statusCode: 401, body: "Unauthorized" };
  //   }
  // }

  try {
    const body = JSON.parse(event.body || "{}");
    console.log("[Webhook] Recibido:", JSON.stringify(body).slice(0, 500));

    const activities = body?.event?.activity || [];
    const solanaTransactions = body?.event?.transaction || [];
    console.log(`[Webhook] Actividades: ${activities.length} | Solana txs: ${solanaTransactions.length}`);

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

    // ── Solana formato nativo (event.transaction) ────────────────
    for (const solTx of solanaTransactions) {
      const signature = solTx.signature || "";
      const txData    = solTx.transaction?.[0];
      const meta      = solTx.meta?.[0];
      if (!txData || !meta) { console.log("[Webhook] Solana tx sin datos, skip"); continue; }

      const accountKeys  = txData.message?.[0]?.account_keys || [];
      const preBalances  = meta.pre_balances  || [];
      const postBalances = meta.post_balances || [];

      // Encontrar índice de la wallet de la plataforma
      const platformIdx = accountKeys.indexOf(PLATFORM_SOLANA);
      if (platformIdx === -1) { console.log("[Webhook] Plataforma no encontrada en account_keys"); continue; }

      // Verificar que recibió fondos
      const pre  = preBalances[platformIdx]  || 0;
      const post = postBalances[platformIdx] || 0;
      const lamportsDiff = post - pre;
      if (lamportsDiff <= 0) { console.log(`[Webhook] Sin ingreso a plataforma (diff=${lamportsDiff})`); continue; }

      // fromAddress = account_keys[0] (el que firma/envía)
      const fromAddress = accountKeys[0] || "";
      const solAmount   = lamportsDiff / 1e9;

      // Leer memo para identificar usuario por userId
      const logMessages = meta.log_messages || [];
      const instructions = txData.message?.[0]?.instructions || [];
      let memoUserId = null;

      // Buscar memo en log_messages (formato: "Program log: futuros:userId")
      for (const log of logMessages) {
        const match = log.match(/futuros:([a-zA-Z0-9\-_]+)/);
        if (match) { memoUserId = match[1]; break; }
      }

      // Si no hay memo, buscar en los datos de instrucciones
      if (!memoUserId) {
        for (const ix of instructions) {
          if (ix.data) {
            try {
              const decoded = Buffer.from(ix.data, "base64").toString("utf8");
              const match = decoded.match(/futuros:([a-zA-Z0-9\-_]+)/);
              if (match) { memoUserId = match[1]; break; }
            } catch(_) {}
          }
        }
      }

      console.log(`[Webhook] Solana nativo: from=${fromAddress} lamports=${lamportsDiff} SOL=${solAmount.toFixed(6)} memo=${memoUserId || "ninguno"} sig=${signature.slice(0,20)}`);

      const usd = await toUSD("SOL", solAmount);
      console.log(`[Webhook] SOL ${solAmount.toFixed(6)} → $${usd.toFixed(4)}`);
      if (usd < 0.01) continue;

      // Si hay memo con userId, buscar directamente por ID
      if (memoUserId) {
        const { data: userById } = await db.from("users").select("*").eq("id", memoUserId).maybeSingle();
        if (userById) {
          // Dedup
          const { data: existingTx } = await db.from("transactions").select("id").ilike("description", `%${signature}%`).maybeSingle();
          if (existingTx) { console.log(`[Webhook] Ya procesado: ${signature}`); continue; }

          const rounded = Math.round(usd * 100) / 100;
          const newBalance = Math.round(((userById.balance || 0) + rounded) * 100) / 100;
          await db.from("users").update({ balance: newBalance }).eq("id", userById.id);
          await db.from("transactions").insert({
            user_id: userById.id, type: "deposit", amount: rounded, network: "solana",
            description: `Depósito SOL +$${rounded.toFixed(2)} · tx:${signature}`,
            status: "confirmed", created_at: new Date().toISOString(),
          });
          console.log(`[Webhook] ✅ +$${rounded.toFixed(2)} SOL → ${userById.username} (por memo) balance: $${newBalance.toFixed(2)}`);
          continue;
        }
      }

      // Sin memo o userId no encontrado → buscar por fromAddress
      await creditUser(fromAddress, usd, "SOL", signature, "solana");
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error("[Webhook] Error crítico:", err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

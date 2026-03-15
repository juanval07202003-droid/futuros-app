const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APISPORTS_KEY = process.env.APISPORTS_KEY;
const NEWSAPI_KEY   = process.env.NEWSAPI_KEY;

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helpers ──────────────────────────────────────────────
function log(msg){ console.log(`[Oracle] ${msg}`); }

// ── SPORTS oracle ────────────────────────────────────────
// config format: "fixture:123456" | "game:856432" | "match:99321"
async function checkSports(config) {
  const [type, id] = config.trim().split(":");
  if (!type || !id) return null;

  const endpoints = {
    fixture: { url: `https://v3.football.api-sports.io/fixtures?id=${id}`,     host: "v3.football.api-sports.io" },
    game:    { url: `https://v1.basketball.api-sports.io/games?id=${id}`,       host: "v1.basketball.api-sports.io" },
    match:   { url: `https://v1.mma.api-sports.io/fights?id=${id}`,            host: "v1.mma.api-sports.io" },
    race:    { url: `https://v1.formula-1.api-sports.io/races?id=${id}`,        host: "v1.formula-1.api-sports.io" },
  };

  const ep = endpoints[type];
  if (!ep) { log(`Tipo deportivo desconocido: ${type}`); return null; }

  try {
    const res = await fetch(ep.url, {
      headers: {
        "x-apisports-key": APISPORTS_KEY,
        "x-rapidapi-host": ep.host,
      }
    });
    const data = await res.json();
    const item = data?.response?.[0];
    if (!item) { log(`No se encontró ${type}:${id}`); return null; }

    // Detectar si el evento terminó según el tipo
    let finished = false;
    let statusCode = "";

    if (type === "fixture") {
      // Fútbol: FT=Full Time, AET=After Extra Time, PEN=Penalties
      statusCode = item.fixture?.status?.short || "";
      finished = ["FT","AET","PEN","AWD","WO"].includes(statusCode);
    } else if (type === "game") {
      // Basketball/NBA
      statusCode = item.status?.short || item.game?.status?.short || "";
      finished = ["FT","AOT"].includes(statusCode);
    } else if (type === "match") {
      // MMA
      statusCode = item.status?.short || "";
      finished = statusCode === "FT" || item.result !== null;
    } else if (type === "race") {
      // F1
      statusCode = item.status || "";
      finished = statusCode === "Completed";
    }

    log(`Sports ${type}:${id} status=${statusCode} finished=${finished}`);
    return finished ? { finished: true, status: statusCode } : null;

  } catch(err) {
    log(`Error consultando sports API: ${err.message}`);
    return null;
  }
}

// ── CRYPTO oracle ────────────────────────────────────────
// config format: "BTC>100000" | "ETH<5000" | "SOL>300"
async function checkCrypto(config) {
  const match = config.trim().match(/^([A-Z]+)\s*([><=!]+)\s*([\d.]+)$/i);
  if (!match) { log(`Config crypto inválida: ${config}`); return null; }

  const [, symbol, operator, valueStr] = match;
  const targetValue = parseFloat(valueStr);

  const coinIds = {
    BTC: "bitcoin", ETH: "ethereum", SOL: "solana",
    BNB: "binancecoin", MATIC: "matic-network", POL: "matic-network",
    ADA: "cardano", DOT: "polkadot", AVAX: "avalanche-2",
    LINK: "chainlink", UNI: "uniswap", ATOM: "cosmos",
  };

  const coinId = coinIds[symbol.toUpperCase()];
  if (!coinId) { log(`Crypto desconocida: ${symbol}`); return null; }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`
    );
    const data = await res.json();
    const currentPrice = data?.[coinId]?.usd;
    if (!currentPrice) { log(`No se pudo obtener precio de ${symbol}`); return null; }

    let conditionMet = false;
    if (operator === ">")  conditionMet = currentPrice > targetValue;
    if (operator === ">=") conditionMet = currentPrice >= targetValue;
    if (operator === "<")  conditionMet = currentPrice < targetValue;
    if (operator === "<=") conditionMet = currentPrice <= targetValue;
    if (operator === "==" || operator === "=") conditionMet = Math.abs(currentPrice - targetValue) < targetValue * 0.001;

    log(`Crypto ${symbol} precio=$${currentPrice} condición=${config} → ${conditionMet}`);
    return conditionMet ? { finished: true, price: currentPrice, condition: config } : null;

  } catch(err) {
    log(`Error consultando CoinGecko: ${err.message}`);
    return null;
  }
}

// ── NEWS oracle ──────────────────────────────────────────
// config format: "keywords, separadas, por coma"
async function checkNews(config, marketTitle) {
  const keywords = config.split(",").map(k => k.trim()).filter(Boolean);
  if (!keywords.length) return null;

  // Construir query combinando keywords del oracle + título del mercado
  const query = keywords.join(" OR ");

  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=es&sortBy=publishedAt&pageSize=5&apiKey=${NEWSAPI_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "ok") { log(`NewsAPI error: ${data.message}`); return null; }

    const articles = data.articles || [];
    if (!articles.length) { log(`News: sin resultados para "${query}"`); return null; }

    // Verificar si algún artículo menciona la resolución del evento
    // Buscamos palabras que indiquen que el evento ya ocurrió
    const resolutionWords = [
      "ganó","gana","ganador","ganadora","venció","vence","venció","victoria",
      "derrotó","derrota","resultó","resultado","terminó","termina","finalizó","finaliza",
      "won","wins","winner","defeated","beats","result","finished","completed",
      "lanzó","lanzamiento","presentó","anunció","nominated","awarded","wins oscar"
    ];

    const latestArticle = articles[0];
    const articleText = `${latestArticle.title} ${latestArticle.description || ""}`.toLowerCase();

    const hasResolution = resolutionWords.some(w => articleText.includes(w.toLowerCase()));

    log(`News query="${query}" articles=${articles.length} hasResolution=${hasResolution}`);
    log(`News latest: "${latestArticle.title}"`);

    if (hasResolution) {
      return {
        finished: true,
        headline: latestArticle.title,
        url: latestArticle.url,
        publishedAt: latestArticle.publishedAt,
      };
    }
    return null;

  } catch(err) {
    log(`Error consultando NewsAPI: ${err.message}`);
    return null;
  }
}

// ── Bloquear mercado en DB ───────────────────────────────
async function lockMarket(marketId, reason, details) {
  log(`🔒 Bloqueando mercado ${marketId} — ${reason}`);

  // 1. Marcar como bloqueado en DB
  const { error } = await db.from("markets")
    .update({ oracle_locked: true })
    .eq("id", marketId);

  if (error) { log(`Error bloqueando: ${error.message}`); return; }

  // 2. Registrar el evento en una tabla de logs del oracle
  await db.from("oracle_events").insert({
    market_id:  marketId,
    reason,
    details:    JSON.stringify(details),
    created_at: new Date().toISOString(),
  }).catch(() => {}); // ignorar si la tabla no existe

  log(`✅ Mercado ${marketId} bloqueado correctamente`);
}

// ── Evaluar un mercado ───────────────────────────────────
async function evaluateMarket(market) {
  const { id, title, oracle_type, oracle_config, oracle_locked, resolved, closes_at } = market;

  // Saltear si ya está bloqueado, resuelto o cerrado por fecha
  if (oracle_locked || resolved) return;
  if (closes_at && new Date(closes_at) <= new Date()) return;
  if (!oracle_type || oracle_type === "none") return;
  if (!oracle_config) return;

  log(`Evaluando "${title}" [${oracle_type}] config="${oracle_config}"`);

  let result = null;

  if (oracle_type === "sports") {
    result = await checkSports(oracle_config);
  } else if (oracle_type === "crypto") {
    result = await checkCrypto(oracle_config);
  } else if (oracle_type === "news") {
    result = await checkNews(oracle_config, title);
  }

  if (result?.finished) {
    await lockMarket(id, oracle_type, result);
  }
}

// ── Handler principal ────────────────────────────────────
exports.handler = async (event) => {
  log("Iniciando ciclo de evaluación...");

  try {
    // Cargar todos los mercados activos con oracle configurado
    const { data: markets, error } = await db
      .from("markets")
      .select("id, title, oracle_type, oracle_config, oracle_locked, resolved, closes_at")
      .eq("resolved", false)
      .neq("oracle_type", "none")
      .not("oracle_config", "is", null);

    if (error) { log(`Error cargando mercados: ${error.message}`); return { statusCode: 500, body: error.message }; }

    log(`${markets?.length || 0} mercados con oracle activo`);

    // Evaluar cada mercado en paralelo (máx 3 simultáneos para no saturar APIs)
    const chunks = [];
    for (let i = 0; i < (markets||[]).length; i += 3) {
      chunks.push(markets.slice(i, i + 3));
    }
    for (const chunk of chunks) {
      await Promise.all(chunk.map(evaluateMarket));
    }

    log("Ciclo completado ✅");
    return { statusCode: 200, body: JSON.stringify({ ok: true, evaluated: markets?.length || 0 }) };

  } catch(err) {
    log(`Error crítico: ${err.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

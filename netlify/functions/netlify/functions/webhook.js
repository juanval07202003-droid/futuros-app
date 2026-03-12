const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL    = "https://xskobwfwxvvazteuwggb.supabase.co";
const SUPABASE_KEY    = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhza29id2Z3eHZ2YXp0ZXV3Z2diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNzk3NDMsImV4cCI6MjA4ODg1NTc0M30.Oxlk7LtATZxqYHXOaA9Em9owG20kDwFtFKB0mbyJpfQ";
const PLATFORM_WALLET = "0xB715A691A5ab505e492eEB6DeFd66F750d9199E3";
const USDC_CONTRACT   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }

  console.log("[webhook] Recibido:", JSON.stringify(payload).slice(0, 300));

  const activities = payload?.event?.activity || [];
  for (const activity of activities) {
    try { await processActivity(activity); }
    catch (e) { console.error("[webhook] Error:", e.message); }
  }

  return { statusCode: 200, body: "OK" };
};

async function processActivity(activity) {
  const { toAddress, asset, value, hash, rawContract, fromAddress } = activity;

  if (!toAddress || toAddress.toLowerCase() !== PLATFORM_WALLET.toLowerCase()) return;

  const isUSDC = rawContract?.address?.toLowerCase() === USDC_CONTRACT.toLowerCase();
  const isMATIC = asset === "MATIC" && !rawContract?.address;
  if (!isUSDC && !isMATIC) return;

  let usdAmount = isUSDC ? parseFloat(value) : await getMaticPriceUSD(parseFloat(value));
  if (!usdAmount || usdAmount < 0.01) return;

  console.log(`[webhook] Depósito: $${usdAmount} (${asset}) hash=${hash}`);

  // Evitar duplicados
  const { data: existing } = await db.from("transactions").select("id").eq("description", `tx:${hash}`).limit(1);
  if (existing && existing.length > 0) { console.log("[webhook] Ya procesado:", hash); return; }

  // Buscar usuario por wallet
  const { data: users } = await db.from("users").select("*").ilike("wallet_address", fromAddress).limit(1);

  if (!users || users.length === 0) {
    console.log("[webhook] Sin usuario para wallet:", fromAddress);
    await db.from("transactions").insert({
      user_id: "unassigned", type: "deposit", amount: usdAmount,
      network: isUSDC ? "usdc" : "polygon",
      description: `tx:${hash} | from:${fromAddress} | SIN USUARIO`,
      status: "pending_assignment", created_at: new Date().toISOString(),
    });
    return;
  }

  const user = users[0];
  const newBalance = (user.balance || 0) + usdAmount;

  const { error } = await db.from("users").update({ balance: newBalance }).eq("id", user.id);
  if (error) { console.error("[webhook] Error balance:", error.message); return; }

  await db.from("transactions").insert({
    user_id: user.id, type: "deposit", amount: usdAmount,
    network: isUSDC ? "usdc" : "polygon",
    description: `tx:${hash}`, status: "confirmed",
    created_at: new Date().toISOString(),
  });

  console.log(`[webhook] ✓ +$${usdAmount} acreditado a ${user.id}`);
}

async function getMaticPriceUSD(maticAmount) {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd");
    const data = await res.json();
    return maticAmount * (data?.["matic-network"]?.usd || 0.5);
  } catch { return maticAmount * 0.5; }
}

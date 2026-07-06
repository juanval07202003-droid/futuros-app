import { createClient } from "@supabase/supabase-js";
import { mnemonicToSeedSync } from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import fetch from "node-fetch";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEED_SOL    = process.env.MASTER_SEED_SOL;
const HELIUS_KEY  = process.env.HELIUS_API_KEY;
const WEBHOOK_ID  = "c075cece-f2cb-4b22-a2bc-520abc80e3fb";

function deriveSolanaAddress(mnemonic, index) {
  const seed = mnemonicToSeedSync(mnemonic);
  const path = "m/44'/501'/" + index + "'/0'";
  const { key } = derivePath(path, seed.toString("hex"));
  const keypair = Keypair.fromSeed(key);
  return keypair.publicKey.toBase58();
}

async function addToHelius(address) {
  if (!HELIUS_KEY) return;
  try {
    const getRes = await fetch("https://api.helius.xyz/v0/webhooks/" + WEBHOOK_ID + "?api-key=" + HELIUS_KEY);
    const webhook = await getRes.json();
    const current = webhook.accountAddresses || [];
    if (current.includes(address)) return;
    await fetch("https://api.helius.xyz/v0/webhooks/" + WEBHOOK_ID + "?api-key=" + HELIUS_KEY, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: webhook.webhookURL,
        transactionTypes: webhook.transactionTypes,
        accountAddresses: [...current, address],
        webhookType: webhook.webhookType || "enhanced",
        authHeader: webhook.authHeader,
      }),
    });
    console.log("  Helius OK: " + address);
  } catch(e) { console.error("  Helius error:", e.message); }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !SEED_SOL) {
    console.error("Faltan variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MASTER_SEED_SOL");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: users, error } = await supabase
    .from("users").select("id,username,deposit_sol_address,deposit_index")
    .is("deposit_sol_address", null);
  if (error) { console.error("Error:", error); process.exit(1); }
  if (!users?.length) { console.log("Todos los usuarios tienen direccion asignada."); return; }
  console.log("Asignando a " + users.length + " usuarios...");
  for (const user of users) {
    try {
      const { data: idx } = await supabase.rpc("get_next_deposit_index", { p_user_id: user.id });
      const index = idx ?? 0;
      const solAddress = deriveSolanaAddress(SEED_SOL, index);
      await supabase.from("users").update({
        deposit_sol_address: solAddress,
        deposit_index: index,
        deposit_memo: null,
      }).eq("id", user.id);
      console.log("OK " + user.username + " -> " + solAddress + " (idx " + index + ")");
      await addToHelius(solAddress);
    } catch(e) { console.error("Error con " + user.username + ":", e.message); }
  }
  console.log("Listo.");
}

main().catch(e => { console.error(e); process.exit(1); });

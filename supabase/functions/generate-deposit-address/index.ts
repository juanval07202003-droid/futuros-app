import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HELIUS_API_KEY = Deno.env.get("HELIUS_API_KEY") || "";
const HELIUS_WEBHOOK_ID = "c075cece-f2cb-4b22-a2bc-520abc80e3fb";

async function addAddressToHelius(address) {
  if (!HELIUS_API_KEY) return false;
  try {
    const getResp = await fetch(
      `https://api.helius.xyz/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`
    );
    if (!getResp.ok) return false;
    const webhook = await getResp.json();
    const currentAddresses = webhook.accountAddresses || [];
    if (currentAddresses.includes(address)) return true;
    const putResp = await fetch(
      `https://api.helius.xyz/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookURL: webhook.webhookURL,
          transactionTypes: webhook.transactionTypes,
          accountAddresses: [...currentAddresses, address],
          webhookType: webhook.webhookType || "enhanced",
          authHeader: webhook.authHeader,
        }),
      }
    );
    return putResp.ok;
  } catch (e) {
    console.error("Helius error:", e);
    return false;
  }
}

async function deriveSolanaAddress(mnemonic, index) {
  const { mnemonicToSeedSync } = await import("https://esm.sh/bip39@3.1.0");
  const { derivePath } = await import("https://esm.sh/ed25519-hd-key@1.3.0");
  const { Keypair } = await import("https://esm.sh/@solana/web3.js@1.87.6");
  const seed = mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const derived = derivePath(path, Buffer.from(seed).toString("hex"));
  const keypair = Keypair.fromSeed(derived.key);
  return keypair.publicKey.toBase58();
}

async function deriveEVMAddress(mnemonic, index) {
  const { mnemonicToSeedSync } = await import("https://esm.sh/bip39@3.1.0");
  const { HDKey } = await import("https://esm.sh/@scure/bip32@1.3.3");
  const { keccak_256 } = await import("https://esm.sh/@noble/hashes@1.3.3/sha3");
  const { secp256k1 } = await import("https://esm.sh/@noble/curves@1.3.0/secp256k1");
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(`m/44'/60'/0'/0/${index}`);
  if (!child.privateKey) throw new Error("No se pudo derivar clave EVM");
  const pubKey = secp256k1.getPublicKey(child.privateKey, false).slice(1);
  const hash = keccak_256(pubKey);
  const addr = "0x" + Array.from(hash.slice(-20)).map(b => b.toString(16).padStart(2,"0")).join("");
  const hashHex = Array.from(keccak_256(new TextEncoder().encode(addr.slice(2).toLowerCase()))).map(b=>b.toString(16).padStart(2,"0")).join("");
  return "0x" + addr.slice(2).split("").map((c,i)=>parseInt(hashHex[i],16)>=8?c.toUpperCase():c.toLowerCase()).join("");
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const { user_id } = await req.json();
  if (!user_id) return new Response(JSON.stringify({ error: "user_id requerido" }), { status: 400 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  const { data: existing } = await supabase.from("users")
    .select("deposit_sol_address,deposit_evm_address,deposit_index").eq("id",user_id).maybeSingle();

  if (existing?.deposit_sol_address && existing?.deposit_evm_address) {
    return new Response(JSON.stringify({ sol: existing.deposit_sol_address, evm: existing.deposit_evm_address }),
      { headers: { "Content-Type": "application/json" } });
  }

  const { data: index } = await supabase.rpc("get_next_deposit_index", { p_user_id: user_id });
  const idx = index ?? 0;
  const seedSol = Deno.env.get("MASTER_SEED_SOL") || "";
  const seedEvm = Deno.env.get("MASTER_SEED_EVM") || "";
  let solAddress = existing?.deposit_sol_address || "";
  let evmAddress = existing?.deposit_evm_address || "";

  try {
    if (!solAddress && seedSol) solAddress = await deriveSolanaAddress(seedSol, idx);
    if (!evmAddress && seedEvm) evmAddress = await deriveEVMAddress(seedEvm, idx);
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }

  await supabase.from("users").update({
    deposit_sol_address: solAddress||null,
    deposit_evm_address: evmAddress||null,
    deposit_index: idx,
  }).eq("id",user_id);

  if (solAddress) await addAddressToHelius(solAddress);

  return new Response(JSON.stringify({ sol: solAddress, evm: evmAddress, index: idx }),
    { headers: { "Content-Type": "application/json" } });
});

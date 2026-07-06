import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function mnemonicToSeed(mnemonic) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(mnemonic.normalize("NFKD")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-512", salt:enc.encode("mnemonic"), iterations:2048 }, key, 512);
  return new Uint8Array(bits);
}

async function hmac512(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, {name:"HMAC",hash:"SHA-512"}, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function deriveSolanaKey(seed, index) {
  const master = await hmac512(new TextEncoder().encode("ed25519 seed"), seed);
  let key = master.slice(0,32), chain = master.slice(32);
  for (const i of [44+0x80000000, 501+0x80000000, index+0x80000000, 0x80000000]) {
    const ib = new Uint8Array(4);
    new DataView(ib.buffer).setUint32(0, i, false);
    const d = await hmac512(chain, new Uint8Array([0,...key,...ib]));
    key = d.slice(0,32); chain = d.slice(32);
  }
  return key;
}

function base58(bytes) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x"+[...bytes].map(b=>b.toString(16).padStart(2,"0")).join(""));
  let r = ""; while(n>0n){r=A[Number(n%58n)]+r;n/=58n;}
  for(const b of bytes){if(b!==0)break;r="1"+r;}
  return r;
}

async function pubKey(priv) {
  const k = await crypto.subtle.importKey("raw", priv, {name:"Ed25519"}, true, ["sign"]);
  return new Uint8Array(await crypto.subtle.exportKey("spki", k)).slice(-32);
}

const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{...CORS,"Content-Type":"application/json"}});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: CORS});
  if (req.method !== "POST") return json({error:"Method not allowed"}, 405);

  const { user_id, index } = await req.json().catch(()=>({}));
  if (!user_id) return json({error:"user_id requerido"}, 400);

  const seedPhrase = Deno.env.get("MASTER_SEED_SOL");
  if (!seedPhrase) return json({error:"Seed no configurada"}, 500);

  const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  const { data: user } = await sb.from("users").select("id,deposit_sol_address").eq("id",user_id).maybeSingle();
  if (!user) return json({error:"Usuario no encontrado"}, 404);

  const MASTER = "8nb7zhT7F3ScEquCzhaQu2uQzgLtj4edgyXiATZyaUcN";
  if (user.deposit_sol_address && user.deposit_sol_address !== MASTER) {
    return json({address: user.deposit_sol_address});
  }

  try {
    const seed = await mnemonicToSeed(seedPhrase);
    const priv = await deriveSolanaKey(seed, index ?? 0);
    const pub = await pubKey(priv);
    const address = base58(pub);

    await sb.from("users").update({deposit_sol_address:address, deposit_index:index??0, deposit_memo:null}).eq("id",user_id);

    const HK = Deno.env.get("HELIUS_API_KEY")||"";
    const WID = "c075cece-f2cb-4b22-a2bc-520abc80e3fb";
    if (HK) {
      try {
        const wh = await (await fetch("https://api.helius.xyz/v0/webhooks/"+WID+"?api-key="+HK)).json();
        const cur = wh.accountAddresses||[];
        if (!cur.includes(address)) {
          await fetch("https://api.helius.xyz/v0/webhooks/"+WID+"?api-key="+HK,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({...wh,accountAddresses:[...cur,address]})});
        }
      } catch(e){console.error("Helius:",e);}
    }

    console.log("OK user="+user_id+" addr="+address+" idx="+(index??0));
    return json({address});
  } catch(e) {
    console.error("Error:", e.message, e.stack);
    return json({error:e.message}, 500);
  }
});

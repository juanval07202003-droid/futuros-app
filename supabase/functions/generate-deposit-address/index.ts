import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MASTER_SOL = "8nb7zhT7F3ScEquCzhaQu2uQzgLtj4edgyXiATZyaUcN";
const MASTER_EVM = "0xB715A691A5ab505e492eEB6DeFd66F750d9199E3";

function generateMemo(index) {
  return "SW-" + String(index).padStart(6, "0");
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const { user_id } = await req.json().catch(() => ({}));
  if (!user_id) return new Response(JSON.stringify({ error: "user_id requerido" }), { status: 400, headers: { "Content-Type": "application/json" } });

  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  const { data: existing } = await supabase.from("users")
    .select("deposit_sol_address,deposit_evm_address,deposit_index,deposit_memo")
    .eq("id", user_id).maybeSingle();

  if (existing?.deposit_sol_address && existing?.deposit_memo) {
    return new Response(JSON.stringify({ sol: existing.deposit_sol_address, evm: existing.deposit_evm_address, memo: existing.deposit_memo }), { headers: { "Content-Type": "application/json" } });
  }

  const { data: idx } = await supabase.rpc("get_next_deposit_index", { p_user_id: user_id });
  const index = idx ?? 0;
  const memo = generateMemo(index);

  await supabase.from("users").update({
    deposit_sol_address: MASTER_SOL,
    deposit_evm_address: MASTER_EVM,
    deposit_index: index,
    deposit_memo: memo,
  }).eq("id", user_id);

  console.log("Usuario " + user_id + " → memo: " + memo);
  return new Response(JSON.stringify({ sol: MASTER_SOL, evm: MASTER_EVM, memo, index }), { headers: { "Content-Type": "application/json" } });
});

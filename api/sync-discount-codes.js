// api/sync-discount-codes.js
// Syncs ONLY unsynced codes (shopify_synced = false) to Shopify
// Uses bulk code creation (up to 100 codes per API call) for speed
// Marks codes as synced in Supabase after successful creation
//
// Call via POST — no body needed, it handles everything automatically

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Get Shopify access token ─────────────────────────────────────────────────
async function getShopifyToken() {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type: "client_credentials",
      }).toString(),
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${err}`);
  }
  const data = await response.json();
  return data.access_token;
}

// ── Get or create price rule for a given discount % ─────────────────────────
async function getOrCreatePriceRule(token, discountPercent) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const title = `Doctor Referral ${discountPercent}% Off`;

  const listRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json?title=${encodeURIComponent(title)}`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  const listData = await listRes.json();
  if (listData.price_rules?.length > 0) return listData.price_rules[0].id;

  const createRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        price_rule: {
          title,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: "percentage",
          value: `-${discountPercent}`,
          customer_selection: "all",
          once_per_customer: true,
          starts_at: new Date().toISOString(),
        },
      }),
    }
  );
  const createData = await createRes.json();
  if (!createData.price_rule) throw new Error(`Failed to create price rule: ${JSON.stringify(createData)}`);
  return createData.price_rule.id;
}

// ── Bulk create up to 100 codes under a price rule ──────────────────────────
async function bulkCreateCodes(token, priceRuleId, codes) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;

  // Submit batch job
  const res = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules/${priceRuleId}/batch_discount_codes.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ codes: codes.map(code => ({ code })) }),
    }
  );

  if (res.status === 429) {
    await sleep(2000);
    return bulkCreateCodes(token, priceRuleId, codes);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bulk create failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  const batchId = data.discount_code_creation?.id;
  if (!batchId) throw new Error(`No batch ID returned: ${JSON.stringify(data)}`);

  // Poll until batch job completes
  let attempts = 0;
  while (attempts < 10) {
    await sleep(1000);
    const pollRes = await fetch(
      `https://${domain}/admin/api/2024-04/price_rules/${priceRuleId}/batch/${batchId}.json`,
      { headers: { "X-Shopify-Access-Token": token } }
    );
    const pollData = await pollRes.json();
    const status = pollData.discount_code_creation?.status;
    if (status === "completed") return pollData;
    if (status === "failed") throw new Error(`Batch job failed: ${JSON.stringify(pollData)}`);
    attempts++;
  }

  return data; // return even if still running after 10 attempts
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const providedSecret = req.headers["x-admin-secret"];
  if (providedSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const limit = parseInt(req.body?.limit ?? 500);

    // 1. Fetch unsynced codes from Supabase
    const { data: codes, error, count } = await supabase
      .from("doctor_codes")
      .select("id, discount_code, customer_discount_rate", { count: "exact" })
      .eq("active", true)
      .eq("shopify_synced", false)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);

    if (!codes || codes.length === 0) {
      return res.status(200).json({
        message: "All codes already synced!",
        remaining: 0,
        done: true,
      });
    }

    console.log(`Syncing ${codes.length} unsynced codes (${count} total remaining)`);

    // 2. Get Shopify token
    const token = await getShopifyToken();

    // 3. Group by discount %
    const byRate = {};
    for (const c of codes) {
      const rate = parseFloat(c.customer_discount_rate);
      if (!byRate[rate]) byRate[rate] = [];
      byRate[rate].push(c);
    }

    const successIds = [];
    const failed = [];

    // 4. Bulk create in chunks of 100 per API call
    for (const [rate, rateCodes] of Object.entries(byRate)) {
      const priceRuleId = await getOrCreatePriceRule(token, rate);

      // Split into chunks of 100
      for (let i = 0; i < rateCodes.length; i += 100) {
        const chunk = rateCodes.slice(i, i + 100);
        const codeStrings = chunk.map(c => c.discount_code);

        try {
          await bulkCreateCodes(token, priceRuleId, codeStrings);
          successIds.push(...chunk.map(c => c.id));
          console.log(`Bulk created ${chunk.length} codes`);
        } catch (err) {
          console.error(`Bulk create error: ${err.message}`);
          failed.push(...codeStrings);
        }

        await sleep(600); // stay under rate limit between bulk calls
      }
    }

    // 5. Mark successfully created codes as synced in Supabase
    if (successIds.length > 0) {
      const { error: updateError } = await supabase
        .from("doctor_codes")
        .update({ shopify_synced: true })
        .in("id", successIds);

      if (updateError) {
        console.error("Failed to mark codes as synced:", updateError);
      }
    }

    const remaining = count - successIds.length;

    return res.status(200).json({
      message: "Batch complete",
      synced: successIds.length,
      failed: failed.length,
      remaining,
      done: remaining <= 0,
    });

  } catch (err) {
    console.error("Sync error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
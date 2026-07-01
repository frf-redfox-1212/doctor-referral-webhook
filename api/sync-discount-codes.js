// api/sync-discount-codes.js
// Reads active codes from Supabase doctor_codes table in batches
// and creates matching discount codes in Shopify via Admin API.
//
// Call via POST with body: { "offset": 0, "limit": 200 }
// Increment offset by limit each call to process all codes.
// Safe to re-run — skips codes that already exist in Shopify.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Get Shopify access token via client credentials grant ───────────────────
async function getShopifyToken() {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.access_token;
}

// ── Create a price rule in Shopify (one per discount %) ────────────────────
async function getOrCreatePriceRule(token, discountPercent) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const title = `Doctor Referral ${discountPercent}% Off`;

  const listRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json?title=${encodeURIComponent(title)}`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  const listData = await listRes.json();

  if (listData.price_rules && listData.price_rules.length > 0) {
    return listData.price_rules[0].id;
  }

  const createRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
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
  if (!createData.price_rule) {
    throw new Error(`Failed to create price rule: ${JSON.stringify(createData)}`);
  }
  return createData.price_rule.id;
}

// ── Create a single discount code under a price rule ───────────────────────
async function createDiscountCode(token, priceRuleId, code) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;

  const res = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules/${priceRuleId}/discount_codes.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ discount_code: { code } }),
    }
  );

  const data = await res.json();

  if (data.errors) {
    if (JSON.stringify(data.errors).includes("taken")) {
      return { skipped: true, code };
    }
    throw new Error(`Failed to create code ${code}: ${JSON.stringify(data.errors)}`);
  }

  return { created: true, code };
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
    const offset = parseInt(req.body?.offset ?? 0);
    const limit = parseInt(req.body?.limit ?? 200);

    console.log(`Syncing codes offset=${offset} limit=${limit}`);

    // 1. Get Shopify access token
    const token = await getShopifyToken();

    // 2. Fetch batch of codes from Supabase
    const { data: codes, error, count } = await supabase
      .from("doctor_codes")
      .select("discount_code, customer_discount_rate, valid_until", { count: "exact" })
      .eq("active", true)
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
    console.log(`Processing ${codes.length} codes (${offset}–${offset + codes.length} of ${count})`);

    // 3. Group by discount %
    const byRate = {};
    for (const c of codes) {
      const rate = parseFloat(c.customer_discount_rate);
      if (!byRate[rate]) byRate[rate] = [];
      byRate[rate].push(c);
    }

    const results = { created: 0, skipped: 0, failed: [] };

    // 4. Create codes in Shopify
    for (const [rate, rateCodes] of Object.entries(byRate)) {
      const priceRuleId = await getOrCreatePriceRule(token, rate);
      for (const c of rateCodes) {
        try {
          const result = await createDiscountCode(token, priceRuleId, c.discount_code);
          if (result.skipped) results.skipped++;
          else results.created++;
        } catch (err) {
          console.error(err.message);
          results.failed.push({ code: c.discount_code, error: err.message });
        }
      }
    }

    return res.status(200).json({
      message: "Batch complete",
      offset,
      limit,
      total_codes: count,
      next_offset: offset + codes.length,
      done: offset + codes.length >= count,
      created: results.created,
      skipped: results.skipped,
      failed: results.failed.length,
    });

  } catch (err) {
    console.error("Sync error:", err);
    return res.status(500).json({ error: err.message });
  }
}


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Get Shopify access token via client credentials grant ───────────────────
async function getShopifyToken() {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.access_token;
}

// ── Create a price rule in Shopify (one per discount %) ────────────────────
async function getOrCreatePriceRule(token, discountPercent) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const title = `Doctor Referral ${discountPercent}% Off`;

  // Check if price rule already exists
  const listRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json?title=${encodeURIComponent(title)}`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  const listData = await listRes.json();

  if (listData.price_rules && listData.price_rules.length > 0) {
    return listData.price_rules[0].id;
  }

  // Create new price rule
  const createRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        price_rule: {
          title,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: "percentage",
          value: `-${discountPercent}`,
          customer_selection: "all",
          once_per_customer: true,        // one use per customer email
          starts_at: new Date().toISOString(),
        },
      }),
    }
  );

  const createData = await createRes.json();
  if (!createData.price_rule) {
    throw new Error(`Failed to create price rule: ${JSON.stringify(createData)}`);
  }
  return createData.price_rule.id;
}

// ── Create a single discount code under a price rule ───────────────────────
async function createDiscountCode(token, priceRuleId, code) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;

  const res = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules/${priceRuleId}/discount_codes.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ discount_code: { code } }),
    }
  );

  const data = await res.json();

  if (data.errors) {
    // Code already exists — not a problem, just skip
    if (JSON.stringify(data.errors).includes("taken")) {
      return { skipped: true, code };
    }
    throw new Error(`Failed to create code ${code}: ${JSON.stringify(data.errors)}`);
  }

  return { created: true, code };
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
    // 1. Get Shopify access token
    console.log("Getting Shopify access token...");
    const token = await getShopifyToken();

    // 2. Fetch all active codes from Supabase
    const { data: codes, error } = await supabase
      .from("doctor_codes")
      .select("discount_code, customer_discount_rate, valid_until")
      .eq("active", true);

    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
    console.log(`Found ${codes.length} active codes to sync`);

    // 3. Group codes by discount % (one price rule per %)
    const byRate = {};
    for (const c of codes) {
      const rate = parseFloat(c.customer_discount_rate);
      if (!byRate[rate]) byRate[rate] = [];
      byRate[rate].push(c);
    }

    const results = { created: [], skipped: [], failed: [] };

    // 4. For each discount %, get/create price rule then create codes
    for (const [rate, rateCodes] of Object.entries(byRate)) {
      console.log(`Processing ${rateCodes.length} codes at ${rate}% discount...`);
      const priceRuleId = await getOrCreatePriceRule(token, rate);

      for (const c of rateCodes) {
        try {
          const result = await createDiscountCode(token, priceRuleId, c.discount_code);
          if (result.skipped) {
            results.skipped.push(c.discount_code);
          } else {
            results.created.push(c.discount_code);
          }
        } catch (err) {
          console.error(err.message);
          results.failed.push({ code: c.discount_code, error: err.message });
        }
      }
    }

    return res.status(200).json({
      message: "Sync complete",
      created: results.created.length,
      skipped: results.skipped.length,
      failed: results.failed.length,
      failed_details: results.failed,
    });

  } catch (err) {
    console.error("Sync error:", err);
    return res.status(500).json({ error: err.message });
  }
}

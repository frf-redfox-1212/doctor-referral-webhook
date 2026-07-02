// api/verify-shopify-sync.js
// Fetches all discount codes from Shopify and marks matching ones
// as shopify_synced = true in Supabase. Run after bulk sync to verify.
//
// Call via POST with header: x-admin-secret: YOUR_ADMIN_SECRET
// Body: { "offset": 0 } — auto-paginates through all Shopify codes

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
  if (!response.ok) throw new Error(`Token exchange failed: ${await response.text()}`);
  const data = await response.json();
  return data.access_token;
}

// ── Get all price rules from Shopify ────────────────────────────────────────
async function getPriceRules(token) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const res = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json?limit=250`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  const data = await res.json();
  return data.price_rules || [];
}

// ── Get a page of discount codes for a price rule ───────────────────────────
async function getDiscountCodes(token, priceRuleId, pageInfo = null) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  let url = `https://${domain}/admin/api/2024-04/price_rules/${priceRuleId}/discount_codes.json?limit=250`;
  if (pageInfo) url += `&page_info=${pageInfo}`;

  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
  
  // Extract next page from Link header
  const linkHeader = res.headers.get("Link") || "";
  const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
  const nextPageInfo = nextMatch ? nextMatch[1] : null;

  const data = await res.json();
  return { codes: data.discount_codes || [], nextPageInfo };
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const providedSecret = req.headers["x-admin-secret"];
  if (providedSecret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });

  try {
    const token = await getShopifyToken();
    const priceRules = await getPriceRules(token);
    console.log(`Found ${priceRules.length} price rules`);

    // Collect all Shopify codes into a Set for fast lookup
    const shopifyCodes = new Set();

    for (const rule of priceRules) {
      let pageInfo = null;
      do {
        const { codes, nextPageInfo } = await getDiscountCodes(token, rule.id, pageInfo);
        codes.forEach(c => shopifyCodes.add(c.code.toUpperCase()));
        pageInfo = nextPageInfo;
        if (pageInfo) await sleep(500); // rate limit
      } while (pageInfo);
    }

    console.log(`Total codes found in Shopify: ${shopifyCodes.size}`);

    // Fetch all codes from Supabase in batches
    let supabaseOffset = 0;
    const batchSize = 1000;
    let totalMarked = 0;
    let totalNotFound = 0;

    while (true) {
      const { data: codes, error } = await supabase
        .from("doctor_codes")
        .select("id, discount_code")
        .range(supabaseOffset, supabaseOffset + batchSize - 1);

      if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
      if (!codes || codes.length === 0) break;

      // Split into synced vs not found
      const syncedIds = codes
        .filter(c => shopifyCodes.has(c.discount_code.toUpperCase()))
        .map(c => c.id);

      const notFoundIds = codes
        .filter(c => !shopifyCodes.has(c.discount_code.toUpperCase()))
        .map(c => c.id);

      // Mark synced ones
      if (syncedIds.length > 0) {
        await supabase
          .from("doctor_codes")
          .update({ shopify_synced: true })
          .in("id", syncedIds);
        totalMarked += syncedIds.length;
      }

      // Mark not-found ones as unsynced
      if (notFoundIds.length > 0) {
        await supabase
          .from("doctor_codes")
          .update({ shopify_synced: false })
          .in("id", notFoundIds);
        totalNotFound += notFoundIds.length;
      }

      console.log(`Processed ${supabaseOffset + codes.length} codes — Synced: ${totalMarked}, Not in Shopify: ${totalNotFound}`);
      supabaseOffset += batchSize;

      if (codes.length < batchSize) break;
    }

    return res.status(200).json({
      message: "Verification complete",
      shopify_total: shopifyCodes.size,
      marked_synced: totalMarked,
      not_in_shopify: totalNotFound,
    });

  } catch (err) {
    console.error("Verify error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

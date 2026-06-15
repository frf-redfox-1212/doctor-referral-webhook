// api/shopify-webhook.js
// Receives Shopify "orders/paid" webhook and logs referral to Supabase

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// ── Supabase client (uses service role key — bypasses RLS) ──────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Disable default body parsing so we can verify Shopify HMAC signature ────
export const config = {
  api: { bodyParser: false },
};

// ── Read raw request body ────────────────────────────────────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ── Verify the request is genuinely from Shopify ────────────────────────────
function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Read raw body
  const rawBody = await getRawBody(req);

  // 2. Verify Shopify signature
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!hmacHeader || !verifyShopifyWebhook(rawBody, hmacHeader, secret)) {
    console.error("Webhook verification failed");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // 3. Parse order data
  const order = JSON.parse(rawBody);

  // 4. Find discount code used (if any)
  const discountCodes = order.discount_codes || [];
  if (discountCodes.length === 0) {
    // No discount code used — not a referral order, ignore
    return res.status(200).json({ message: "No discount code, skipping" });
  }

  const usedCode = discountCodes[0].code.toUpperCase().trim();

  // 5. Look up doctor by discount code
  const { data: doctor, error: doctorError } = await supabase
    .from("doctors")
    .select("id, name, referral_rate")
    .eq("discount_code", usedCode)
    .eq("active", true)
    .single();

  if (doctorError || !doctor) {
    // Code used doesn't belong to any doctor — ignore
    console.log(`No active doctor found for code: ${usedCode}`);
    return res.status(200).json({ message: "Code not a doctor referral, skipping" });
  }

  // 6. Extract order details
  const orderValue = parseFloat(order.total_price);
  const customerEmail = order.email || "";
  const customerName =
    `${order.billing_address?.first_name || ""} ${order.billing_address?.last_name || ""}`.trim();

  // 7. Log referral to Supabase
  const { error: insertError } = await supabase.from("referrals").insert({
    doctor_id: doctor.id,
    shopify_order_id: String(order.id),
    shopify_order_number: order.name,       // e.g. "#1042"
    customer_email: customerEmail,
    customer_name: customerName,
    order_value: orderValue,
    referral_rate: doctor.referral_rate,    // snapshot current rate
    discount_code: usedCode,
  });

  if (insertError) {
    console.error("Supabase insert error:", insertError);
    return res.status(500).json({ error: "Failed to log referral" });
  }

  console.log(
    `Referral logged — Doctor: ${doctor.name}, Order: ${order.name}, Value: ${orderValue}`
  );

  return res.status(200).json({ message: "Referral logged successfully" });
}

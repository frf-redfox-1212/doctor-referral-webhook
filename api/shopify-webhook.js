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

// ── Send an email via Brevo API ─────────────────────────────────────────────
async function sendEmail({ to, toName, subject, htmlContent }) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        name: process.env.SENDER_NAME || "Referral System",
        email: process.env.SENDER_EMAIL,
      },
      to: [{ email: to, name: toName }],
      subject,
      htmlContent,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Brevo send failed: ${response.status} ${errText}`);
  }
  return response.json();
}

// ── Build "order paid" notification email ───────────────────────────────────
function buildOrderPaidEmailHtml({ doctorName, orderNumber, orderValue, referralRate, payoutAmount, customerName }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2>New Referral Order Placed</h2>
      <p>An order has been placed using referral code for <strong>Dr. ${doctorName}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Order</strong></td><td style="padding:8px;border:1px solid #ddd;">${orderNumber}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Customer</strong></td><td style="padding:8px;border:1px solid #ddd;">${customerName || "N/A"}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Order Value</strong></td><td style="padding:8px;border:1px solid #ddd;">₹${orderValue}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Referral Rate</strong></td><td style="padding:8px;border:1px solid #ddd;">${referralRate}%</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Referral Amount</strong></td><td style="padding:8px;border:1px solid #ddd;">₹${payoutAmount}</td></tr>
      </table>
      <p style="color:#666;font-size:13px;">This referral amount will be eligible for payout 15 days after delivery is confirmed. This is an automated notification.</p>
    </div>
  `;
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

  // 5. Look up the code in doctor_codes, then get the linked doctor
  const { data: codeRow, error: codeError } = await supabase
    .from("doctor_codes")
    .select("doctor_id")
    .eq("discount_code", usedCode)
    .eq("active", true)
    .single();

  if (codeError || !codeRow) {
    // Code doesn't exist or isn't active — not a doctor referral, ignore
    console.log(`No active doctor code found for: ${usedCode}`);
    return res.status(200).json({ message: "Code not a doctor referral, skipping" });
  }

  const { data: doctor, error: doctorError } = await supabase
    .from("doctors")
    .select("id, name, email, referral_rate, mr_name, mr_email")
    .eq("id", codeRow.doctor_id)
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

  // 8. Calculate payout amount for the email (same formula as DB generated column)
  const payoutAmount = Math.round(orderValue * doctor.referral_rate) / 100;

  const emailHtml = buildOrderPaidEmailHtml({
    doctorName: doctor.name,
    orderNumber: order.name,
    orderValue,
    referralRate: doctor.referral_rate,
    payoutAmount,
    customerName,
  });

  // 9. Email the doctor (best-effort — don't fail the webhook if email fails)
  try {
    if (doctor.email) {
      await sendEmail({
        to: doctor.email,
        toName: doctor.name,
        subject: `New Referral Order — ${order.name}`,
        htmlContent: emailHtml,
      });
    }
  } catch (err) {
    console.error("Doctor order-paid email failed:", err);
  }

  // 10. Email the MR (if one is linked to this doctor)
  try {
    if (doctor.mr_email) {
      await sendEmail({
        to: doctor.mr_email,
        toName: doctor.mr_name || "MR",
        subject: `New Referral Order for Dr. ${doctor.name} — ${order.name}`,
        htmlContent: emailHtml,
      });
    }
  } catch (err) {
    console.error("MR order-paid email failed:", err);
  }

  return res.status(200).json({ message: "Referral logged successfully" });
}

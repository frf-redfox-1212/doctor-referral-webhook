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
function buildOrderPaidEmailHtml({ recipientRole, doctorName, orderNumber, untaxedAmount, rate, payoutAmount, customerName, orderType }) {
  const orderTypeLabel = orderType === "first" ? "First order (code used)" : "Repeat order (no code needed)";
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2>New Referral Order — ${recipientRole}</h2>
      <p>An order has been placed for <strong>Dr. ${doctorName}</strong>'s patient.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Order</strong></td><td style="padding:8px;border:1px solid #ddd;">${orderNumber}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Order Type</strong></td><td style="padding:8px;border:1px solid #ddd;">${orderTypeLabel}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Customer</strong></td><td style="padding:8px;border:1px solid #ddd;">${customerName || "N/A"}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Order Value (untaxed)</strong></td><td style="padding:8px;border:1px solid #ddd;">₹${untaxedAmount}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Your Rate</strong></td><td style="padding:8px;border:1px solid #ddd;">${rate}%</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Your Referral Amount</strong></td><td style="padding:8px;border:1px solid #ddd;">₹${payoutAmount}</td></tr>
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

  // 4. Basic order details
  const customerEmail = (order.email || "").toLowerCase().trim();
  const customerName =
    `${order.billing_address?.first_name || ""} ${order.billing_address?.last_name || ""}`.trim();
  const untaxedAmount = parseFloat(order.subtotal_price); // after discount, before tax/shipping
  const orderValue = parseFloat(order.total_price);

  if (!customerEmail) {
    return res.status(200).json({ message: "No customer email on order, skipping" });
  }

  const discountCodes = order.discount_codes || [];
  let usedCode = discountCodes.length > 0
    ? discountCodes[0].code.toUpperCase().trim()
    : null;

  let doctor, mrRate, doctorRate, orderType, customerLinkId, codeRow;

  // ── Try the code path first (if a code was used) ──────────────────────────
  if (usedCode) {
    const { data: foundCode } = await supabase
      .from("doctor_codes")
      .select("*")
      .eq("discount_code", usedCode)
      .eq("active", true)
      .single();

    const codeIsUsable =
      foundCode &&
      !foundCode.discount_used &&
      new Date(foundCode.valid_until) > new Date();

    if (codeIsUsable) {
      codeRow = foundCode;
    }
  }

  if (codeRow) {
    // ── FIRST ORDER: valid, unused code ──────────────────────────────────────
    const { data: foundDoctor, error: doctorError } = await supabase
      .from("doctors")
      .select("id, name, email, mr_name, mr_email")
      .eq("id", codeRow.doctor_id)
      .eq("active", true)
      .single();

    if (doctorError || !foundDoctor) {
      console.log(`Code ${usedCode} has no active doctor, skipping`);
      return res.status(200).json({ message: "Code has no active doctor, skipping" });
    }

    doctor = foundDoctor;
    mrRate = codeRow.mr_referral_rate;
    doctorRate = codeRow.doctor_referral_rate;
    orderType = "first";

    // Create the customer link so future orders (no code) still pay out
    const { data: link, error: linkError } = await supabase
      .from("customer_links")
      .insert({
        customer_email: customerEmail,
        doctor_id: doctor.id,
        doctor_code_id: codeRow.id,
        mr_referral_rate: mrRate,
        doctor_referral_rate: doctorRate,
        expires_at: codeRow.valid_until,
      })
      .select()
      .single();

    if (linkError) {
      console.error("Failed to create customer link:", linkError);
    } else {
      customerLinkId = link.id;
    }

    // Mark the code as used (one-time discount only)
    await supabase
      .from("doctor_codes")
      .update({ discount_used: true })
      .eq("id", codeRow.id);
  } else {
    // ── No usable code: check if this customer is already linked ────────────
    const { data: activeLink } = await supabase
      .from("customer_links")
      .select("*")
      .eq("customer_email", customerEmail)
      .eq("active", true)
      .gt("expires_at", new Date().toISOString())
      .order("linked_at", { ascending: false })
      .limit(1)
      .single();

    if (!activeLink) {
      // Not a referral order at all — ignore
      return res.status(200).json({ message: "No active code or customer link, skipping" });
    }

    const { data: foundDoctor, error: doctorError } = await supabase
      .from("doctors")
      .select("id, name, email, mr_name, mr_email")
      .eq("id", activeLink.doctor_id)
      .eq("active", true)
      .single();

    if (doctorError || !foundDoctor) {
      return res.status(200).json({ message: "Linked doctor inactive, skipping" });
    }

    doctor = foundDoctor;
    mrRate = activeLink.mr_referral_rate;
    doctorRate = activeLink.doctor_referral_rate;
    orderType = "repeat";
    customerLinkId = activeLink.id;

    // Pull the original linking code's text for traceability (referrals.discount_code)
    const { data: originalCode } = await supabase
      .from("doctor_codes")
      .select("discount_code")
      .eq("id", activeLink.doctor_code_id)
      .single();

    if (originalCode) {
      usedCode = originalCode.discount_code;
    }
  }

  // 5. Calculate split payouts (on untaxed amount)
  const mrPayoutAmount = Math.round(untaxedAmount * mrRate) / 100;
  const doctorPayoutAmount = Math.round(untaxedAmount * doctorRate) / 100;

  // 6. Log referral to Supabase
  const { error: insertError } = await supabase.from("referrals").insert({
    doctor_id: doctor.id,
    shopify_order_id: String(order.id),
    shopify_order_number: order.name,
    customer_email: customerEmail,
    customer_name: customerName,
    order_value: orderValue,
    discount_code: usedCode,
    customer_link_id: customerLinkId,
    order_type: orderType,
    untaxed_amount: untaxedAmount,
    mr_referral_rate: mrRate,
    doctor_referral_rate: doctorRate,
    mr_payout_amount: mrPayoutAmount,
    doctor_payout_amount: doctorPayoutAmount,
  });

  if (insertError) {
    console.error("Supabase insert error:", insertError);
    return res.status(500).json({ error: "Failed to log referral" });
  }

  console.log(
    `Referral logged (${orderType}) — Doctor: ${doctor.name}, Order: ${order.name}, Untaxed: ${untaxedAmount}`
  );

  // 7. Email the doctor (best-effort — don't fail the webhook if email fails)
  try {
    if (doctor.email) {
      await sendEmail({
        to: doctor.email,
        toName: doctor.name,
        subject: `New Referral Order — ${order.name}`,
        htmlContent: buildOrderPaidEmailHtml({
          recipientRole: "Doctor",
          doctorName: doctor.name,
          orderNumber: order.name,
          untaxedAmount,
          rate: doctorRate,
          payoutAmount: doctorPayoutAmount,
          customerName,
          orderType,
        }),
      });
    }
  } catch (err) {
    console.error("Doctor order-paid email failed:", err);
  }

  // 8. Email the MR (if one is linked to this doctor)
  try {
    if (doctor.mr_email) {
      await sendEmail({
        to: doctor.mr_email,
        toName: doctor.mr_name || "MR",
        subject: `New Referral Order for Dr. ${doctor.name} — ${order.name}`,
        htmlContent: buildOrderPaidEmailHtml({
          recipientRole: "MR",
          doctorName: doctor.name,
          orderNumber: order.name,
          untaxedAmount,
          rate: mrRate,
          payoutAmount: mrPayoutAmount,
          customerName,
          orderType,
        }),
      });
    }
  } catch (err) {
    console.error("MR order-paid email failed:", err);
  }

  return res.status(200).json({ message: "Referral logged successfully", order_type: orderType });
}

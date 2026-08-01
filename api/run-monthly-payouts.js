// api/run-monthly-payouts.js
// Runs automatically on 1st of every month via Vercel cron
// OR manually triggered via POST with x-admin-secret header
// Processes all eligible doctor payouts via Cashfree

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CASHFREE_BASE = process.env.CASHFREE_ENV === "PRODUCTION"
  ? "https://payout-api.cashfree.com"
  : "https://payout-gamma.cashfree.com";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getCashfreeToken() {
  const res = await fetch(`${CASHFREE_BASE}/payout/v1/authorize`, {
    method: "POST",
    headers: {
      "X-Client-Id": process.env.CASHFREE_CLIENT_ID,
      "X-Client-Secret": process.env.CASHFREE_CLIENT_SECRET,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json();
  if (data.status !== "SUCCESS") throw new Error(`Cashfree auth failed: ${JSON.stringify(data)}`);
  return data.data.token;
}

async function sendPayout(token, { transferId, beneficiaryId, amount, remarks }) {
  const res = await fetch(`${CASHFREE_BASE}/payout/v1/requestTransfer`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      beneId: beneficiaryId,
      amount: amount.toFixed(2),
      transferId,
      transferMode: "banktransfer",
      remarks,
    }),
  });
  return await res.json();
}

export default async function handler(req, res) {
  // Allow both GET (cron) and POST (manual trigger)
  if (req.method === "POST") {
    const providedSecret = req.headers["x-admin-secret"];
    if (providedSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    console.log("Starting monthly payout run...");

    // 1. Get all doctors with eligible unpaid referrals + registered bank details
    const { data: eligibleDoctors, error } = await supabase
      .from("unpaid_referrals")
      .select("doctor_id, doctor_name, doctor_email, doctor_total_owed, doctor_unpaid_order_count")
      .gt("doctor_total_owed", 0);

    if (error) throw new Error(`Failed to fetch eligible doctors: ${error.message}`);
    if (!eligibleDoctors || eligibleDoctors.length === 0) {
      return res.status(200).json({ message: "No eligible payouts this month", processed: 0 });
    }

    console.log(`Found ${eligibleDoctors.length} doctors with eligible payouts`);

    const token = await getCashfreeToken();
    const results = { success: [], failed: [], skipped: [] };
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split("T")[0];
    const periodEnd = now.toISOString().split("T")[0];

    for (const doc of eligibleDoctors) {
      // Check if doctor has registered bank details
      const { data: bank } = await supabase
        .from("doctor_bank_details")
        .select("cashfree_beneficiary_id, cashfree_registered")
        .eq("doctor_id", doc.doctor_id)
        .single();

      if (!bank || !bank.cashfree_registered || !bank.cashfree_beneficiary_id) {
        results.skipped.push({ doctor: doc.doctor_name, reason: "No registered bank details" });
        console.log(`Skipped ${doc.doctor_name} — no bank details`);
        continue;
      }

      const amount = parseFloat(doc.doctor_total_owed);
      const transferId = `KLAB_${doc.doctor_id.replace(/-/g, '').substring(0, 12).toUpperCase()}_${Date.now()}`;
      const remarks = `KLAB Nutra referral payout — ${doc.doctor_unpaid_order_count} orders`;

      try {
        // Create payout_log entry
        const { data: payoutLog, error: logError } = await supabase
          .from("payout_log")
          .insert({
            doctor_id: doc.doctor_id,
            recipient_type: "doctor",
            recipient_name: doc.doctor_name,
            recipient_email: doc.doctor_email,
            period_start: periodStart,
            period_end: periodEnd,
            total_payout: amount,
            payment_method: "Cashfree",
            status: "processing",
            cashfree_transfer_id: transferId,
          })
          .select()
          .single();

        if (logError) throw new Error(`Failed to create payout log: ${logError.message}`);

        // Send payout via Cashfree
        const payoutResult = await sendPayout(token, {
          transferId,
          beneficiaryId: bank.cashfree_beneficiary_id,
          amount,
          remarks,
        });

        console.log(`Cashfree payout result for ${doc.doctor_name}:`, JSON.stringify(payoutResult));

        if (payoutResult.status === "SUCCESS") {
          // Link referrals to this payout
          const { data: referrals } = await supabase
            .from("referrals")
            .select("id")
            .eq("doctor_id", doc.doctor_id)
            .eq("status", "delivered")
            .is("doctor_payout_id", null)
            .lte("eligible_at", now.toISOString());

          if (referrals && referrals.length > 0) {
            await supabase
              .from("referrals")
              .update({ doctor_payout_id: payoutLog.id })
              .in("id", referrals.map(r => r.id));
          }

          // Update payout log status
          await supabase.from("payout_log")
            .update({ status: "processing", paid_on: periodEnd })
            .eq("id", payoutLog.id);

          results.success.push({ doctor: doc.doctor_name, amount, transfer_id: transferId });
          console.log(`✓ Payout initiated for ${doc.doctor_name} — ₹${amount}`);
        } else {
          await supabase.from("payout_log")
            .update({ status: "failed", failure_reason: JSON.stringify(payoutResult) })
            .eq("id", payoutLog.id);

          results.failed.push({ doctor: doc.doctor_name, amount, error: JSON.stringify(payoutResult) });
          console.error(`✗ Payout failed for ${doc.doctor_name}:`, payoutResult);
        }

      } catch (err) {
        results.failed.push({ doctor: doc.doctor_name, amount, error: err.message });
        console.error(`✗ Error processing ${doc.doctor_name}:`, err.message);
      }

      await sleep(500); // Rate limit between payouts
    }

    return res.status(200).json({
      message: "Monthly payout run complete",
      success: results.success.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
      details: results,
    });

  } catch (err) {
    console.error("Monthly payout error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

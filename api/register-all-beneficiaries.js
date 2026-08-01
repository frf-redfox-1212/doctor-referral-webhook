// api/register-all-beneficiaries.js
// Registers all doctors with bank details who aren't yet registered with Cashfree

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const providedSecret = req.headers["x-admin-secret"];
  if (providedSecret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Get all doctors with bank details not yet registered
    const { data: bankDetails, error } = await supabase
      .from("doctor_bank_details")
      .select("*, doctors(id, name, email, phone)")
      .eq("cashfree_registered", false);

    if (error) throw new Error(`Supabase error: ${error.message}`);
    if (!bankDetails || bankDetails.length === 0) {
      return res.status(200).json({ message: "All doctors already registered", registered: 0, already_registered: 0, failed: 0 });
    }

    const token = await getCashfreeToken();
    let registered = 0, already_registered = 0;
    const failed_details = [];

    for (const bank of bankDetails) {
      const doctor = bank.doctors;
      if (!doctor) continue;

      const beneficiaryId = `KLAB_${doctor.id.replace(/-/g, '').substring(0, 16).toUpperCase()}`;

      try {
        const regRes = await fetch(`${CASHFREE_BASE}/payout/v1/addBeneficiary`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            beneId: beneficiaryId,
            name: bank.account_holder_name,
            email: doctor.email || "noreply@klabnutra.com",
            phone: doctor.phone || "9999999999",
            bankAccount: bank.bank_account,
            ifsc: bank.bank_ifsc,
            address1: "India",
          }),
        });

        const result = await regRes.json();
        console.log(`${doctor.name}:`, JSON.stringify(result));

        if (result.status === "SUCCESS" || result.subCode === "409") {
          await supabase.from("doctor_bank_details").update({
            cashfree_beneficiary_id: beneficiaryId,
            cashfree_registered: true,
          }).eq("id", bank.id);
          result.subCode === "409" ? already_registered++ : registered++;
        } else {
          failed_details.push({ doctor: doctor.name, error: JSON.stringify(result) });
        }
      } catch (err) {
        failed_details.push({ doctor: doctor.name, error: err.message });
      }

      await sleep(300);
    }

    return res.status(200).json({
      message: "Registration complete",
      registered,
      already_registered,
      failed: failed_details.length,
      failed_details,
    });

  } catch (err) {
    console.error("Register all error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

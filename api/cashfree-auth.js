// cashfree-auth.js
// Shared Cashfree authentication using Public Key signature method
// Used by register-all-beneficiaries.js and run-monthly-payouts.js

import crypto from "crypto";

const CASHFREE_BASE = process.env.CASHFREE_ENV === "PRODUCTION"
  ? "https://payout-api.cashfree.com"
  : "https://payout-gamma.cashfree.com";

export { CASHFREE_BASE };

// ── Get Cashfree auth token using Public Key signature ───────────────────────
export async function getCashfreeToken() {
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  const publicKey = process.env.CASHFREE_PUBLIC_KEY;

  // Generate timestamp
  const timestamp = Math.floor(Date.now() / 1000);

  let headers = {
    "X-Client-Id": clientId,
    "X-Client-Secret": clientSecret,
    "Content-Type": "application/json",
  };

  // Generate signature using public key
  if (publicKey) {
    const data = `${clientId}.${timestamp}`;

    // PHP docs use openssl_public_encrypt = PKCS1 padding
    const signature = crypto
      .publicEncrypt(
        {
          key: publicKey,
          padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        Buffer.from(data)
      )
      .toString("base64");

    headers["X-Cf-Signature"] = signature;
    headers["X-Cf-Timestamp"] = timestamp.toString();
  }

  const res = await fetch(`${CASHFREE_BASE}/payout/v1/authorize`, {
    method: "POST",
    headers,
  });

  const responseText = await res.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Cashfree auth response not JSON: ${responseText}`);
  }

  if (data.status !== "SUCCESS") {
    throw new Error(`Cashfree auth failed: ${JSON.stringify(data)}`);
  }

  return data.data.token;
}

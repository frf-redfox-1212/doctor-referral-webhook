// cashfree-auth.js
// Cashfree Payouts authentication using @cashfreepayments/cashfree-sdk
// Handles public key signature automatically for dynamic IPs

import { createRequire } from "module";
const require = createRequire(import.meta.url);

export const CASHFREE_BASE = process.env.CASHFREE_ENV === "PRODUCTION"
  ? "https://payout-api.cashfree.com"
  : "https://payout-gamma.cashfree.com";

export async function getCashfreeInstance() {
  const { Payouts } = require("@cashfreepayments/cashfree-sdk");

  const config = {
    env: process.env.CASHFREE_ENV === "PRODUCTION" ? "PRODUCTION" : "TEST",
    clientId: process.env.CASHFREE_CLIENT_ID,
    clientSecret: process.env.CASHFREE_CLIENT_SECRET,
  };

  // Add public key if available (for dynamic IP environments like Vercel)
  if (process.env.CASHFREE_PUBLIC_KEY) {
    config.publicKey = process.env.CASHFREE_PUBLIC_KEY;
  }

  const payoutsInstance = new Payouts(config);
  return payoutsInstance;
}

export async function getCashfreeToken() {
  const instance = await getCashfreeInstance();
  const tokenRes = await instance.getToken();
  
  if (tokenRes.status !== "SUCCESS") {
    throw new Error(`Cashfree auth failed: ${JSON.stringify(tokenRes)}`);
  }

  return tokenRes.data.token;
}

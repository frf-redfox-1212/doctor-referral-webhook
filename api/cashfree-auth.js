// cashfree-auth.js
// Cashfree authentication using official cashfree-sdk npm package
// The SDK handles public key signature internally

export const CASHFREE_ENV = process.env.CASHFREE_ENV === "PRODUCTION" ? "PROD" : "TEST";

export async function getCashfreeToken() {
  const { Payouts } = await import("@cashfreepayments/cashfree-sdk");

  const payoutsInstance = new Payouts({
    env: CASHFREE_ENV,
    clientId: process.env.CASHFREE_CLIENT_ID,
    clientSecret: process.env.CASHFREE_CLIENT_SECRET,
    publicKey: process.env.CASHFREE_PUBLIC_KEY || undefined,
  });

  const tokenRes = await payoutsInstance.GetToken();
  if (tokenRes.status !== "SUCCESS") {
    throw new Error(`Cashfree auth failed: ${JSON.stringify(tokenRes)}`);
  }

  return { token: tokenRes.data.token, instance: payoutsInstance };
}

export const CASHFREE_BASE = process.env.CASHFREE_ENV === "PRODUCTION"
  ? "https://payout-api.cashfree.com"
  : "https://payout-gamma.cashfree.com";

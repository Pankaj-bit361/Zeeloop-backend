/* Checks that every configured provider plan charges what plans.js promises.

   The mistake this exists to catch: BILLING_VARIANT_STARTER and
   BILLING_VARIANT_GROWTH are two opaque ids pasted into a console minutes
   apart. Swap them and a customer clicking Starter is charged $99, the
   subscription activates, the webhook applies GROWTH, and every screen agrees
   with itself. Nothing is broken enough to notice — until someone reads a card
   statement.

   Same class of error: a plan created in INR while the page says USD, or an
   amount typed as 2900 in a field that wanted 29.

   Read-only. Fetches each plan from the provider and compares. Run it after
   changing plan ids, and before pointing real customers at checkout:

       npm run verify:plans
*/
require("dotenv").config();
const config = require("../config/config");
const { PLANS } = require("../config/plans");
const { PlanId, BillingProvider } = require("../config/enums");

const PAID = [PlanId.STARTER, PlanId.GROWTH, PlanId.SCALE];

async function fetchRazorpayPlan(planId) {
    const auth = Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString("base64");
    const response = await fetch(`https://api.razorpay.com/v1/plans/${planId}`, {
        headers: { Authorization: `Basic ${auth}` },
    });
    if (!response.ok) {
        return { success: false, error: `HTTP ${response.status} ${await response.text().catch(() => "")}` };
    }
    const json = await response.json();
    const item = json.item || {};
    return {
        success: true,
        // Razorpay returns the smallest currency unit: cents for USD, paise for
        // INR. 2900 is $29.00, not $2,900 — a distinction worth making loudly.
        amount: typeof item.amount === "number" ? item.amount / 100 : null,
        currency: item.currency || null,
        name: item.name || "",
        period: json.period,
        interval: json.interval,
    };
}

async function main() {
    if (config.BILLING_PROVIDER !== BillingProvider.RAZORPAY) {
        console.log(`BILLING_PROVIDER is ${config.BILLING_PROVIDER}; this script only knows Razorpay.`);
        process.exit(0);
    }
    if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) {
        console.error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.");
        process.exit(1);
    }

    // rzp_test_ vs rzp_live_ — test and live have separate plans, so a live key
    // with test plan ids 404s and vice versa. Worth naming before the results.
    const mode = config.RAZORPAY_KEY_ID.startsWith("rzp_live") ? "LIVE" : "TEST";
    console.log(`Razorpay ${mode} mode\n`);

    let failed = 0;

    for (const currency of ["USD", "INR"]) {
      const priceField = currency === "USD" ? "priceUsd" : "priceInr";
      for (const planId of PAID) {
        const expected = PLANS[planId];
        const variantId = (config.BILLING_VARIANT_IDS[currency] || {})[planId];
        const label = `${expected.name.padEnd(8)} ${currency} (${planId})`;

        if (!variantId) {
            // INR plans are created after the USD ones; missing is a warning
            // there and a failure for USD, which every deployment must have.
            if (currency === "INR") {
                console.warn(`! ${label}  no BILLING_VARIANT_${planId}_INR configured — Indian workspaces get 503 at checkout`);
                continue;
            }
            console.error(`✗ ${label}  no BILLING_VARIANT_${planId} configured`);
            failed++;
            continue;
        }

        const actual = await fetchRazorpayPlan(variantId);
        if (!actual.success) {
            console.error(`✗ ${label}  ${variantId} — ${actual.error}`);
            failed++;
            continue;
        }

        const problems = [];
        if (actual.amount !== expected[priceField]) {
            problems.push(`charges ${actual.currency} ${actual.amount}, plans.js says ${currency} ${expected[priceField]}`);
        }
        if (actual.currency !== currency) {
            problems.push(`currency is ${actual.currency}, not ${currency}`);
        }
        if (actual.period !== "monthly" || actual.interval !== 1) {
            problems.push(`bills ${actual.period} every ${actual.interval}, expected monthly every 1`);
        }
        if (actual.name && !actual.name.toLowerCase().includes(expected.name.toLowerCase())) {
            problems.push(`provider calls it "${actual.name}"`);
        }

        if (problems.length) {
            console.error(`✗ ${label}  ${variantId}`);
            for (const problem of problems) console.error(`      ${problem}`);
            failed++;
        } else {
            console.log(`✓ ${label}  ${variantId}  ${currency} ${actual.amount} monthly`);
        }
      }
    }

    console.log("");
    if (failed) {
        console.error(`${failed} plan(s) do not match plans.js. Fix before taking payments.`);
        process.exit(1);
    }
    console.log("All plans match plans.js.");
}

if (require.main === module) {
    main().catch((error) => {
        console.error("verify:plans failed:", error.message);
        process.exit(1);
    });
}

module.exports = { main };

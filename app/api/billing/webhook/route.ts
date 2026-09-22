import { observeRequest, reportError } from "@/server/operations/monitoring";
import { BillingError } from "@/server/billing/errors";
import { billingProvider, processBillingEvent } from "@/server/billing/service";
export const runtime = "nodejs";
async function webhook(request: Request) {
  try {
    const signature = request.headers.get("stripe-signature");
    if (!signature) throw new BillingError("BILLING_SIGNATURE", 400);
    // Preserve the signed bytes and bound input before allocating a full body.
    const reader = request.body?.getReader();
    if (!reader) throw new BillingError("BILLING_SIGNATURE", 400);
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
      chunks.push(value);
    }
    const provider = billingProvider();
    const event = provider.verify(Buffer.concat(chunks).toString("utf8"), signature);
    return Response.json(await processBillingEvent(event, provider));
  } catch (error) {
    const safe = error instanceof BillingError ? error : new BillingError("BILLING_UNAVAILABLE");
    if (safe.code !== "BILLING_SIGNATURE") reportError(error, { route: "/api/billing/webhook", errorCode: safe.code });
    // Even permanent mapping failures return 5xx so a corrected configuration
    // can recover via Stripe retry; only invalid signatures return 400.
    return Response.json({ error: safe.message }, { status: safe.code === "BILLING_SIGNATURE" ? 400 : 503 });
  }
}

export function POST(request: Request) { return observeRequest(request, () => webhook(request)); }

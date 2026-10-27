import { NextResponse } from "next/server";
import { affiliateApiError, noStoreHeaders } from "../../../../affiliate/affiliate-api";
import { listNewArrivalsForAffiliate } from "../../../../affiliate/new-arrivals-service";
import { currentCustomerSession } from "../../../../auth/customer-auth";

export async function GET() {
  try {
    return NextResponse.json(
      { items: await listNewArrivalsForAffiliate(await currentCustomerSession()) },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    return affiliateApiError(error, "affiliate_new_arrivals_failed");
  }
}

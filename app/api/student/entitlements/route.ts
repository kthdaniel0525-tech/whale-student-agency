import { api } from "@/server/api";
import { publicUserEntitlements } from "@/server/entitlements/usage";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return api(request, publicUserEntitlements, false); }

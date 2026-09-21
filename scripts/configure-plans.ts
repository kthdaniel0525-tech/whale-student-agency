import "dotenv/config";
import { syncDevelopmentPlans } from "../server/entitlements/service";
import { db } from "../server/db/client";
// Explicit operator command: apply the checked-in development catalog to storage.
try { await syncDevelopmentPlans(); console.info("Development plan catalog synchronized."); }
finally { await db().$disconnect(); }

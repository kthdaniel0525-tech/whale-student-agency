"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAuthClient } from "better-auth/react";
import { Button } from "@/components/ui/button";
export function BetaSignOut() {
  const [error, setError] = useState(""); const router = useRouter();
  return <><Button variant="outline" onClick={async () => { try { const result = await createAuthClient().signOut(); if (result.error) throw Error(); router.replace("/sign-in"); router.refresh(); } catch { setError("Unable to sign out. Please try again."); } }}>Sign out</Button>{error && <p role="alert">{error}</p>}</>;
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "authenticated") router.replace("/trips");
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);
  return <div className="p-10 text-center text-sm text-muted">載入中…</div>;
}

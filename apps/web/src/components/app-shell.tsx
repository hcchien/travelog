"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { LogoPin } from "./icons";
import { Avatar, cx } from "./ui";

const NAV = [
  { href: "/trips", label: "我的行程" },
  { href: "/places", label: "我的地點" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { me } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-4 px-5 py-3 sm:px-7">
          <Link href="/trips" className="flex items-center gap-2 text-navy">
            <LogoPin className="size-6 text-accent" />
            <span className="text-[19px] font-bold">Travelog</span>
          </Link>
          <nav aria-label="主選單" className="flex gap-1">
            {NAV.map((n) => {
              const active = pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "rounded-lg px-3.5 py-2 text-[15px]",
                    active
                      ? "bg-brand-soft font-semibold text-brand"
                      : "text-ink-soft hover:bg-canvas",
                  )}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto">
            <Link href="/settings" aria-label="帳號設定" className="block rounded-full">
              {me && <Avatar name={me.displayName} size={38} />}
            </Link>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

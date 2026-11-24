import Link from "next/link";

export const metadata = { title: "服務條款｜Travelog" };

export default function Page() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-5 py-16">
      <h1 className="text-3xl font-bold">服務條款</h1>
      <p className="rounded-xl bg-[#fdebdd] px-4 py-3 text-pin-ink">
        尚未發布：正式上線前需要撰寫並經過檢視。
      </p>
      <Link href="/login" className="text-brand">
        回到登入
      </Link>
    </main>
  );
}

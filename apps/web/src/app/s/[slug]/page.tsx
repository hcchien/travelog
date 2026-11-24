import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LogoPin } from "@/components/icons";
import { JournalBody } from "@/components/journal-doc";
import type { PublicEntry, PublicTravelogue } from "@/lib/types";

/** 公開遊記（M6）：伺服器端渲染，不需要登入。 */

const API =
  process.env.API_INTERNAL_ORIGIN ?? process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:8080";

async function load(slug: string): Promise<PublicTravelogue | null> {
  if (!/^[2-9a-z]{8,20}$/.test(slug)) return null;
  const res = await fetch(`${API}/v1/public/${slug}`, { next: { revalidate: 60 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`公開遊記載入失敗：${res.status}`);
  return res.json();
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await load((await params).slug);
  if (!data) return { title: "找不到遊記・Travelog" };
  const where = data.trip.destinations.map((d) => d.name).join("、");
  return {
    title: `${data.trip.title}・Travelog`,
    description: `${where ? `${where}・` : ""}${data.trip.startDate} – ${data.trip.endDate}`,
    robots: { index: false },
    openGraph: { title: data.trip.title, type: "article" },
  };
}

const WEEK = "日一二三四五六";
const dayLabel = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日（${WEEK[d.getUTCDay()]}）`;
};

function Entry({ e }: { e: PublicEntry }) {
  return (
    <article className="flex flex-col gap-2 rounded-2xl bg-white p-5">
      {e.title && <h3 className="text-lg font-bold">{e.title}</h3>}
      <JournalBody doc={e.body} />
      {e.author && <span className="text-right text-sm text-muted">— {e.author}</span>}
    </article>
  );
}

export default async function PublicPage({ params }: Props) {
  const data = await load((await params).slug);
  if (!data) notFound();
  const { trip } = data;
  return (
    <div className="min-h-screen bg-canvas">
      <header className="bg-navy px-5 pt-10 pb-8 text-white">
        <div className="mx-auto flex max-w-[760px] flex-col gap-2">
          <span className="text-sm text-[#c5cedb]">
            {trip.destinations.map((d) => d.name).join("・")}
          </span>
          <h1 className="text-3xl font-bold">{trip.title}</h1>
          <span className="text-[#c5cedb]">
            {dayLabel(trip.startDate)} – {dayLabel(trip.endDate)}
          </span>
        </div>
      </header>
      <main className="mx-auto flex max-w-[760px] flex-col gap-8 px-5 py-8">
        {data.entries.map((e) => (
          <Entry key={e.id} e={e} />
        ))}
        {data.days.map((d, i) =>
          d.items.length === 0 && d.entries.length === 0 ? null : (
            <section key={d.date} className="flex flex-col gap-3">
              <h2 className="flex items-baseline gap-3">
                <span className="text-xl font-bold">
                  Day {i + 1}
                  {d.title ? `・${d.title}` : ""}
                </span>
                <span className="text-sm text-muted">{dayLabel(d.date)}</span>
              </h2>
              {d.items.length > 0 && (
                <ol className="flex flex-col gap-1 rounded-2xl border border-line bg-white px-5 py-3">
                  {d.items.map((it) => (
                    <li key={it.id} className="flex gap-3 py-1 text-[15px]">
                      <span className="w-12 flex-none text-muted">{it.time ?? ""}</span>
                      <span className="font-semibold">{it.title}</span>
                      {it.place && it.place.name !== it.title && (
                        <span className="truncate text-muted">{it.place.name}</span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {d.entries.map((e) => (
                <Entry key={e.id} e={e} />
              ))}
            </section>
          ),
        )}
      </main>
      <footer className="flex items-center justify-center gap-1.5 pb-10 text-sm text-muted">
        <LogoPin className="size-4 text-accent" />用 Travelog 規劃與記錄
      </footer>
    </div>
  );
}

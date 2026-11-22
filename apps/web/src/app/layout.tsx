import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const viewport = { themeColor: "#16263D" };

export const metadata: Metadata = {
  title: "Travelog",
  appleWebApp: { capable: true, title: "Travelog", statusBarStyle: "black-translucent" },
  description: "和旅伴一起規劃行程、旅途中隨時查資料、回來後寫下心得。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&display=swap"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

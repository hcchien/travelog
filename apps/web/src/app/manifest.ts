import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Travelog",
    short_name: "Travelog",
    description: "和旅伴一起規劃行程、旅途中隨時查資料、回來後寫下心得。",
    start_url: "/trips",
    display: "standalone",
    background_color: "#F5F6F8",
    theme_color: "#16263D",
    lang: "zh-Hant",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}

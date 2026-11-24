"use client";

import { AdvancedMarker, APIProvider, Map as GoogleMap, useMap } from "@vis.gl/react-google-maps";
import { useEffect } from "react";

export interface MapPoint {
  id: string;
  label: string;
  title: string;
  lat: number;
  lng: number;
  confirmed?: boolean;
}

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || "DEMO_MAP_ID";

function FitBounds({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || points.length === 0) return;
    if (points.length === 1) {
      map.setCenter(points[0] as google.maps.LatLngLiteral);
      map.setZoom(15);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const p of points) bounds.extend(p);
    map.fitBounds(bounds, 48);
  }, [map, points]);
  return null;
}

/** 行程點地圖。沒有設定金鑰時改為顯示清單，不影響其他功能。 */
export function TripMap({ points }: { points: MapPoint[] }) {
  if (!KEY) {
    return (
      <section
        className="flex h-72 flex-col gap-2 overflow-y-auto rounded-2xl border border-line bg-[#e8ece4] p-4"
        aria-label="地點清單"
      >
        <span className="text-xs text-ink-soft">設定 NEXT_PUBLIC_GOOGLE_MAPS_KEY 後會顯示地圖</span>
        {points.length === 0 && (
          <span className="text-sm text-muted">這天還沒有帶地點的行程點</span>
        )}
        {points.map((p) => (
          <div key={p.id} className="flex items-center gap-2 text-sm">
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-bold text-white ${p.confirmed ? "bg-pin" : "bg-navy"}`}
            >
              {p.label}
            </span>
            {p.title}
          </div>
        ))}
      </section>
    );
  }
  return (
    <div className="h-80 overflow-hidden rounded-2xl border border-line">
      <APIProvider apiKey={KEY} language="zh-TW">
        <GoogleMap
          mapId={MAP_ID}
          defaultCenter={{ lat: 35.0, lng: 135.77 }}
          defaultZoom={12}
          gestureHandling="cooperative"
          disableDefaultUI={false}
        >
          {points.map((p) => (
            <AdvancedMarker key={p.id} position={p} title={p.title}>
              <span
                className={`flex size-7 items-center justify-center rounded-full border-2 border-white text-[13px] font-bold text-white shadow ${p.confirmed ? "bg-pin" : "bg-navy"}`}
              >
                {p.label}
              </span>
            </AdvancedMarker>
          ))}
          <FitBounds points={points} />
        </GoogleMap>
      </APIProvider>
    </div>
  );
}

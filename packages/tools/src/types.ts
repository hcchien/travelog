// 工具用到的 API 回應（與 apps/api 的 serialize 對應，只列需要的欄位）

export interface Trip {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  primaryTz: string;
  destinations: { cityKey: string; name: string }[];
  myRole: "owner" | "editor" | "viewer";
}

export interface TripDetail extends Trip {
  days: { id: string; date: string; title: string | null }[];
  members: { userId: string; displayName: string; role: string }[];
}

export interface Place {
  googlePlaceId: string;
  name: string;
  address: string | null;
  tz: string | null;
  cityName: string | null;
  category: string;
}

export interface Item {
  id: string;
  dayId: string | null;
  type: string;
  title: string;
  notes: string | null;
  place: Place | null;
  startAt: string | null;
  endAt: string | null;
  tz: string;
  confirmed: boolean;
  booking: {
    kind: string;
    status: string;
    confirmationCode: string | null;
    provider: string | null;
  } | null;
  version: number;
}

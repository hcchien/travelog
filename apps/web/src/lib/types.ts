// API 回應型別（與 apps/api 的 serialize 函式對應）

export type TripRole = "owner" | "editor" | "viewer";
export type ItemType = "sight" | "food" | "stay" | "transport" | "activity" | "note";
export type BookingStatus = "planned" | "booked" | "cancelled";
export type BookingKind =
  | "flight"
  | "lodging"
  | "rail"
  | "bus"
  | "car"
  | "ticket"
  | "restaurant"
  | "other";
export type SavedCategory = "food" | "cafe" | "sight" | "shopping" | "stay" | "other";

export interface Me {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  primaryEmail: string | null;
  defaultTz: string;
  identities: {
    id: string;
    provider: "google" | "apple";
    email: string | null;
    isPrivateRelay: boolean;
  }[];
}

export interface Destination {
  cityKey: string;
  name: string;
}

export interface Trip {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  primaryTz: string;
  destinations: Destination[];
  cover: string | null;
  status: string;
  ownerId: string;
  version: number;
  myRole: TripRole;
}

export interface TripDay {
  id: string;
  date: string;
  title: string | null;
}

export interface Member {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: TripRole;
}

export interface TripDetail extends Trip {
  days: TripDay[];
  members: Member[];
}

export interface Place {
  id: string;
  googlePlaceId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  tz: string | null;
  cityKey: string | null;
  cityName: string | null;
  category: SavedCategory;
  googleMapsUri: string | null;
}

export interface Booking {
  id: string;
  kind: BookingKind;
  status: BookingStatus;
  confirmationCode: string | null;
  provider: string | null;
  details: Record<string, unknown>;
}

export interface Item {
  id: string;
  tripId: string;
  dayId: string | null;
  type: ItemType;
  title: string;
  notes: string | null;
  place: Place | null;
  startAt: string | null;
  endAt: string | null;
  tz: string;
  sortKey: string;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmSource: "booking" | "manual" | null;
  booking: Booking | null;
  version: number;
}

export interface Warning {
  type: "overlaps-confirmed";
  itemId: string;
}

export interface WishlistEntry {
  id: string;
  note: string | null;
  place: Place;
  addedBy: { userId: string; displayName?: string };
  votes: number;
  votedByMe: boolean;
}

export interface SavedPlace {
  id: string;
  cityKey: string;
  cityName: string;
  category: SavedCategory;
  tags: string[];
  privateNote: string | null;
  place: Place;
}

export interface Suggestion {
  googlePlaceId: string;
  mainText: string;
  secondaryText: string;
}

export interface Invitation {
  id: string;
  role: TripRole;
  email: string | null;
  expiresAt: string | null;
  status: "valid" | "expired" | "revoked" | "used";
  url?: string;
}

export interface Activity {
  id: string;
  action: string;
  via: "web" | "app" | "mcp" | "ai_assistant";
  actorName: string | null;
  diff: Record<string, unknown> | null;
  createdAt: string;
}

export interface Passkey {
  id: string;
  name: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

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
  viewerCanWriteJournal?: boolean;
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
  rating: number | null;
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
  undoable: boolean;
  undone: boolean;
  via: "web" | "app" | "mcp";
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

export interface Note {
  id: string;
  body: string;
  takenAt: string;
  lat: number | null;
  lng: number | null;
  dayId: string | null;
  itemId: string | null;
  mergedIntoEntryId?: string | null;
  author: { userId: string; displayName: string | null };
}

export interface Snapshot {
  trip: TripDetail;
  items: Item[];
  notes: Note[];
  generatedAt: string;
}

export interface Connection {
  clientId: string;
  name: string;
  verifiedDomain: string | null;
  scopes: string[];
  lastUsedAt: string;
}

export interface Attachment {
  id: string;
  itemId: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  status: "pending" | "ready";
  uploadedBy: string;
  createdAt: string;
}

export type JournalMark =
  | { type: "bold" | "italic" | "strike" | "code" }
  | { type: "link"; attrs: { href: string } };
export interface JournalNode {
  type: string;
  text?: string;
  marks?: JournalMark[];
  attrs?: { level?: number };
  content?: JournalNode[];
}
export interface JournalDoc {
  type: "doc";
  content: JournalNode[];
}

export interface JournalEntry {
  id: string;
  scope: "trip" | "day" | "item";
  dayId: string | null;
  itemId: string | null;
  title: string | null;
  body: JournalDoc;
  bodyText: string;
  visibility: "members" | "public";
  version: number;
  author: { userId: string; displayName: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface ShareLink {
  id: string;
  slug: string;
  url: string;
  options: { hideLodging: boolean; journalOnly: boolean };
  createdAt: string;
}

export interface PublicTravelogue {
  trip: {
    title: string;
    startDate: string;
    endDate: string;
    destinations: Destination[];
    cover: unknown;
  };
  options: { hideLodging: boolean; journalOnly: boolean };
  entries: PublicEntry[];
  days: {
    date: string;
    title: string | null;
    items: {
      id: string;
      title: string;
      type: string;
      time: string | null;
      place: { name: string } | null;
    }[];
    entries: PublicEntry[];
  }[];
}
export interface PublicEntry {
  id: string;
  title: string | null;
  body: JournalDoc;
  author: string | null;
  itemId: string | null;
}

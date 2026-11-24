export type TripRole = "owner" | "editor" | "viewer";
export type ItemType = "transport" | "stay" | "food" | "sight" | "activity" | "shopping" | "other";

export interface Me {
  id: string;
  displayName: string;
  primaryEmail: string | null;
}

export interface Trip {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  primaryTz: string;
  destinations: { cityKey: string; name: string }[];
  myRole: TripRole;
  version: number;
}

export interface Day {
  id: string;
  date: string;
  title: string | null;
}

export interface TripDetail extends Trip {
  days: Day[];
  members: { userId: string; displayName: string; role: TripRole }[];
}

export interface Place {
  googlePlaceId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface Item {
  id: string;
  dayId: string | null;
  type: ItemType;
  title: string;
  notes: string | null;
  startAt: string | null;
  endAt: string | null;
  tz: string;
  confirmed: boolean;
  booking: { kind: string; status: string; confirmationCode: string | null } | null;
  place: Place | null;
}

export interface Note {
  id: string;
  body: string;
  takenAt: string;
  dayId: string | null;
  mergedIntoEntryId?: string | null;
  author: { userId: string; displayName: string | null };
}

export interface Snapshot {
  trip: TripDetail;
  items: Item[];
  notes: Note[];
  generatedAt: string;
}

export interface JournalEntry {
  id: string;
  scope: "trip" | "day" | "item";
  dayId: string | null;
  title: string | null;
  bodyText: string;
  /** 網站編輯器的格式化內容；App 只編輯純文字。 */
  body: { content: { type: string; content?: { marks?: unknown[] }[] }[] };
  visibility: "members" | "public";
  version: number;
  author: { userId: string; displayName: string | null };
}

export interface Attachment {
  id: string;
  itemId: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
}

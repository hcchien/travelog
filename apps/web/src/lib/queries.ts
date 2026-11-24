"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Item, SavedPlace, TripDetail, WishlistEntry } from "./types";

export const keys = {
  trip: (id: string) => ["trip", id] as const,
  items: (id: string) => ["items", id] as const,
  wishlist: (id: string) => ["wishlist", id] as const,
  savedForTrip: (id: string) => ["saved", "trip", id] as const,
  saved: ["saved"] as const,
};

export const useTrip = (id: string) =>
  useQuery({ queryKey: keys.trip(id), queryFn: () => api<TripDetail>("GET", `/v1/trips/${id}`) });

export const useItems = (id: string) =>
  useQuery({
    queryKey: keys.items(id),
    queryFn: async () => (await api<{ items: Item[] }>("GET", `/v1/trips/${id}/items`)).items,
  });

export const useWishlist = (id: string) =>
  useQuery({
    queryKey: keys.wishlist(id),
    queryFn: async () =>
      (await api<{ items: WishlistEntry[] }>("GET", `/v1/trips/${id}/wishlist`)).items,
  });

export const useSavedForTrip = (id: string) =>
  useQuery({
    queryKey: keys.savedForTrip(id),
    queryFn: async () =>
      (await api<{ items: SavedPlace[] }>("GET", `/v1/me/saved-places?tripId=${id}`)).items,
  });

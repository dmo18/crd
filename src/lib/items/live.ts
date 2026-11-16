import { isNull, type SQL } from "drizzle-orm";
import { items } from "@/db/schema";

/**
 * Items that are part of the collection: not in Recently deleted. Every
 * reader of `items` adds this, except the bin itself, restore, purge and
 * photo housekeeping (each says why in a comment).
 */
export const liveItem: SQL = isNull(items.deletedAt);

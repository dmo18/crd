import { and, inArray, isNull, notInArray, type SQL } from "drizzle-orm";
import { GONE_STATUSES, items } from "@/db/schema";

/**
 * Items that are part of the collection: not in Recently deleted, and not
 * sold or removed (GONE_STATUSES in src/db/schema.ts). Every reader that
 * counts, totals, lists or checks for duplicates adds this, except the bin
 * itself, restore, purge, photo housekeeping and the "Sold and removed" list
 * (each says why in a comment).
 */
export const liveItem: SQL = and(isNull(items.deletedAt), notInArray(items.status, [...GONE_STATUSES]))!;

/** Not in Recently deleted, whatever the status. For the screens that show sold and removed items too. */
export const notDeleted: SQL = isNull(items.deletedAt);

/** Sold or removed, and not in Recently deleted. */
export const goneItem: SQL = and(isNull(items.deletedAt), inArray(items.status, [...GONE_STATUSES]))!;

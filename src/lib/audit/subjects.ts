import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { items, locations } from "@/db/schema";

/** "item 12, 1989 Topps Ken Griffey Jr." for the activity log. Read it before the item is gone. */
export function itemLabel(id: number, db: Db = getDb()): string {
  const row = db.select({ title: items.title }).from(items).where(eq(items.id, id)).get();
  return row ? `item ${id}, ${row.title}` : `item ${id}`;
}

/** The location's name for the activity log. Read it before the location is gone. */
export function locationLabel(id: number, db: Db = getDb()): string {
  const row = db.select({ name: locations.name }).from(locations).where(eq(locations.id, id)).get();
  return row ? row.name : `number ${id}`;
}

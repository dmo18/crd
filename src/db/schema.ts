import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Shared value lists. Import these instead of retyping the strings. */
export const ITEM_KINDS = ["card", "sealed", "bulk"] as const;
export const ITEM_STATUSES = ["needs_review", "confirmed"] as const;
export const SCAN_MODES = ["single", "multi", "sealed", "bulk"] as const;
export const SCAN_STATUSES = ["queued", "processing", "done", "failed"] as const;
export const SPORTS = ["baseball", "basketball", "football", "hockey", "soccer", "golf", "racing", "wrestling", "boxing", "multi", "other"] as const;
export const CONDITIONS = ["poor", "fair", "good", "very_good", "excellent", "near_mint", "mint", "gem_mint"] as const;
export const RARITY_TIERS = ["common", "minor_star", "star", "key", "grail"] as const;
export const PRODUCT_TYPES = ["pack", "rack_pack", "cello_pack", "blister", "box", "case", "factory_set", "other"] as const;
export const SEAL_STATES = ["factory_sealed", "possibly_resealed", "opened", "unknown"] as const;
export const IMAGE_ROLES = ["front", "back", "source", "crop"] as const;
export const VALUE_SOURCES = ["ai_estimate", "manual", "sample", "price_feed"] as const;
/** What a booked sign-in attempt was for. All kinds count toward the same limits. */
export const ATTEMPT_KINDS = ["login", "setup", "change_password"] as const;
/** Events kept in the activity log (More, Activity). */
export const AUDIT_EVENTS = [
  "sign_in_ok", "sign_in_failed", "sign_in_blocked", "setup_done", "setup_failed", "password_changed",
  "signed_out", "signed_out_others", "export_csv", "item_deleted", "failed_scans_deleted", "items_merged",
  "location_deleted", "backup_note",
] as const;
/** Sign-in and account events. The rest are changes to the collection. */
export const SECURITY_AUDIT_EVENTS = [
  "sign_in_ok", "sign_in_failed", "sign_in_blocked", "setup_done", "setup_failed", "password_changed",
  "signed_out", "signed_out_others",
] as const satisfies readonly (typeof AUDIT_EVENTS)[number][];
export const AUDIT_OUTCOMES = ["ok", "failed", "blocked"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ScanMode = (typeof SCAN_MODES)[number];
export type ScanStatus = (typeof SCAN_STATUSES)[number];
export type Sport = (typeof SPORTS)[number];
export type Condition = (typeof CONDITIONS)[number];
export type RarityTier = (typeof RARITY_TIERS)[number];
export type ProductType = (typeof PRODUCT_TYPES)[number];
export type SealState = (typeof SEAL_STATES)[number];
export type ImageRole = (typeof IMAGE_ROLES)[number];
export type ValueSource = (typeof VALUE_SOURCES)[number];
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];
export type AuditEvent = (typeof AUDIT_EVENTS)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

const now = sql`(unixepoch() * 1000)`;
const bool = (name: string) => integer(name, { mode: "boolean" }).notNull().default(false);
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

/** Where things physically live: a box, binder, shelf. */
export const locations = sqliteTable("locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  kind: text("kind"),
  notes: text("notes"),
  createdAt: ts("created_at").notNull().default(now),
}, (t) => [
  // "Box 1" and "box 1" are the same place, even when two saves race.
  uniqueIndex("locations_name_lower_unique").on(sql`lower(${t.name})`),
]);

/** One scanning action: one or more photos sent for recognition. */
export const scans = sqliteTable("scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mode: text("mode", { enum: SCAN_MODES }).notNull(),
  status: text("status", { enum: SCAN_STATUSES }).notNull().default("queued"),
  /** Optional words from the owner to help the AI, e.g. "1989 Topps baseball". */
  hint: text("hint"),
  locationId: integer("location_id").references(() => locations.id, { onDelete: "set null" }),
  /** Short, safe message shown to the owner when a scan fails. */
  error: text("error"),
  itemCount: integer("item_count").notNull().default(0),
  recognizer: text("recognizer"),
  createdAt: ts("created_at").notNull().default(now),
  /** When processing last began. Null while the scan waits in the queue. */
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  /** Random id the scan screen makes per entry, so a repeated upload never makes a second scan. */
  clientKey: text("client_key"),
}, (t) => [index("scans_status_idx").on(t.status), uniqueIndex("scans_client_key_uq").on(t.clientKey)]);

/**
 * Everything in the collection. One table for three kinds:
 * - card: a single card (quantity above 1 means duplicates)
 * - sealed: an unopened pack, box, case or factory set
 * - bulk: a lot of loose cards counted, not scanned one by one
 */
export const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ITEM_KINDS }).notNull(),
  status: text("status", { enum: ITEM_STATUSES }).notNull().default("needs_review"),
  scanId: integer("scan_id").references(() => scans.id, { onDelete: "set null" }),
  /** Display name, rebuilt from the fields below whenever they change. */
  title: text("title").notNull(),

  // What it is (cards, and where it applies sealed and bulk)
  sport: text("sport", { enum: SPORTS }),
  year: integer("year"),
  /** Last year of a range, for bulk lots such as 1987 to 1991. */
  yearEnd: integer("year_end"),
  brand: text("brand"),
  setName: text("set_name"),
  cardNumber: text("card_number"),
  player: text("player"),
  team: text("team"),
  /** Parallel, insert or subset name, e.g. "Tiffany", "Desert Shield". */
  variation: text("variation"),

  // Rarity signals
  isRookie: bool("is_rookie"),
  isError: bool("is_error"),
  isParallel: bool("is_parallel"),
  isInsert: bool("is_insert"),
  isAutograph: bool("is_autograph"),
  isMemorabilia: bool("is_memorabilia"),
  /** Print run text when the card is numbered, e.g. "045/100". */
  serialNumber: text("serial_number"),
  rarityTier: text("rarity_tier", { enum: RARITY_TIERS }),
  rarityNotes: text("rarity_notes"),

  // Condition
  condition: text("condition", { enum: CONDITIONS }),
  conditionNotes: text("condition_notes"),
  grader: text("grader"),
  grade: text("grade"),
  certNumber: text("cert_number"),
  worthGrading: integer("worth_grading", { mode: "boolean" }),
  gradingNotes: text("grading_notes"),

  // Sealed product only
  productType: text("product_type", { enum: PRODUCT_TYPES }),
  packCount: integer("pack_count"),
  sealState: text("seal_state", { enum: SEAL_STATES }),

  // Bulk lots only
  estCount: integer("est_count"),
  containerType: text("container_type"),
  description: text("description"),
  /** JSON list of card names worth pulling out of this lot first. */
  pullList: text("pull_list"),

  quantity: integer("quantity").notNull().default(1),
  locationId: integer("location_id").references(() => locations.id, { onDelete: "set null" }),
  notes: text("notes"),

  // Recognition
  /** 0 to 1. Below the review threshold the item waits in the review queue. */
  confidence: real("confidence"),
  aiNotes: text("ai_notes"),

  // Value, always whole US cents, per single unit (multiply by quantity for totals)
  estLowCents: integer("est_low_cents"),
  estHighCents: integer("est_high_cents"),
  estValueCents: integer("est_value_cents"),
  valueSource: text("value_source", { enum: VALUE_SOURCES }),
  valueBasis: text("value_basis"),
  valuedAt: ts("valued_at"),
  /** The owner's own figure. When set it wins over the estimate. */
  manualValueCents: integer("manual_value_cents"),

  createdAt: ts("created_at").notNull().default(now),
  updatedAt: ts("updated_at").notNull().default(now),
}, (t) => [
  index("items_kind_idx").on(t.kind),
  index("items_status_idx").on(t.status),
  index("items_player_idx").on(t.player),
  index("items_year_idx").on(t.year),
  index("items_scan_idx").on(t.scanId),
  index("items_location_idx").on(t.locationId),
]);

/**
 * Photos. Files live on disk under DATA_DIR/uploads, never in the database.
 * The file name's extension tells the format: `.avif` for the small archive
 * copy, `.jpg` for photos stored before AVIF (converted in the background).
 */
export const images = sqliteTable("images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: integer("item_id").references(() => items.id, { onDelete: "cascade" }),
  scanId: integer("scan_id").references(() => scans.id, { onDelete: "cascade" }),
  role: text("role", { enum: IMAGE_ROLES }).notNull(),
  /** Server generated file name. Never a name supplied by the browser. */
  file: text("file").notNull().unique(),
  thumbFile: text("thumb_file").notNull(),
  /**
   * Full quality JPEG kept in DATA_DIR/uploads/work while card reading may
   * still need it (same id as `file`). Null once the photo is in its archive
   * form; until then `file` does not exist yet and the working copy is shown.
   */
  workFile: text("work_file"),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  /** Size of the full size file on disk (the working copy while there is one). */
  bytes: integer("bytes").notNull(),
  /** Size of the small picture. 0 on rows from before this was recorded. */
  thumbBytes: integer("thumb_bytes").notNull().default(0),
  createdAt: ts("created_at").notNull().default(now),
}, (t) => [index("images_item_idx").on(t.itemId), index("images_scan_idx").on(t.scanId), index("images_work_idx").on(t.workFile)]);

/** Every value an item has had, so value over time can be shown. */
export const valuations = sqliteTable("valuations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  source: text("source", { enum: VALUE_SOURCES }).notNull(),
  lowCents: integer("low_cents"),
  highCents: integer("high_cents"),
  valueCents: integer("value_cents").notNull(),
  basis: text("basis"),
  createdAt: ts("created_at").notNull().default(now),
}, (t) => [index("valuations_item_idx").on(t.itemId)]);

/** One row per day: the whole collection's worth, for the dashboard chart. */
export const collectionSnapshots = sqliteTable("collection_snapshots", {
  day: text("day").primaryKey(),
  totalValueCents: integer("total_value_cents").notNull(),
  itemCount: integer("item_count").notNull(),
  unitCount: integer("unit_count").notNull(),
});

/** Failed and successful sign-in attempts, used to slow down guessing. */
export const loginAttempts = sqliteTable("login_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ip: text("ip").notNull(),
  success: bool("success"),
  /** Sign-in, first-run setup or password change. Only a marker: limits count every kind. */
  kind: text("kind", { enum: ATTEMPT_KINDS }).notNull().default("login"),
  /** The wider network for the shared limit: an IPv6 /48, or the IPv4 address itself. Null on old rows. */
  net: text("net"),
  /**
   * Set when the attempt came from a trusted device (a browser that signed in
   * before). Those attempts count only toward that device's own limit.
   */
  deviceId: text("device_id"),
  createdAt: ts("created_at").notNull().default(now),
}, (t) => [
  index("login_attempts_ip_idx").on(t.ip, t.createdAt),
  index("login_attempts_device_idx").on(t.deviceId, t.createdAt),
]);

/**
 * The owner password when it was set in the app (first-run setup) instead of
 * in OWNER_PASSWORD_HASH_B64. At most one row, always id 1. A password set in
 * the server settings wins over this row.
 */
export const ownerSettings = sqliteTable("owner_settings", {
  id: integer("id").primaryKey(),
  /** bcrypt hash. Never the password itself. */
  passwordHash: text("password_hash").notNull(),
  /** Raised on every password change, which signs out every other device. Starts at 1. */
  sessionVersion: integer("session_version").notNull().default(1),
  updatedAt: ts("updated_at").notNull().default(now),
}, () => [check("owner_settings_single_row", sql`id = 1`)]);

/**
 * Sign-in state that is not a password. At most one row, always id 1.
 * `envSessionVersion` is the session version used while the password comes
 * from OWNER_PASSWORD_HASH_B64; "Sign out all other devices" raises it. A
 * missing row means version 0, which is what such sessions carried before.
 */
export const authState = sqliteTable("auth_state", {
  id: integer("id").primaryKey(),
  envSessionVersion: integer("env_session_version").notNull().default(0),
  updatedAt: ts("updated_at").notNull().default(now),
}, () => [check("auth_state_single_row", sql`id = 1`)]);

/**
 * Security and housekeeping events for the owner's activity page. Kept 365
 * days. Never holds passwords, codes, cookies or other secrets.
 */
export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: ts("at").notNull().default(now),
  event: text("event", { enum: AUDIT_EVENTS }).notNull(),
  /** Visitor address as used for sign-in limits (IPv6 as its /64), or "unknown". */
  ip: text("ip").notNull(),
  /** Trusted-device id of the browser, when it had one. */
  deviceId: text("device_id"),
  outcome: text("outcome", { enum: AUDIT_OUTCOMES }).notNull(),
  /** Short plain text, at most 200 characters. */
  detail: text("detail"),
}, (t) => [
  index("audit_events_at_idx").on(t.at),
  index("audit_events_event_idx").on(t.event, t.at),
]);

/** When each kind of alert was last sent, so alerts are not repeated too often. */
export const alertState = sqliteTable("alert_state", {
  key: text("key").primaryKey(),
  lastSentAt: ts("last_sent_at").notNull(),
});

/** Facts about players from Wikidata (free, no key), cached so each name is looked up once. */
export const playerFacts = sqliteTable("player_facts", {
  /** Lowercased name with spaces collapsed, plus the sport when known, e.g. "frank thomas|baseball". */
  key: text("key").primaryKey(),
  /** JSON array of candidate PlayerFacts, re-ranked by card year on each use; null when nothing was found (misses are cached too). */
  facts: text("facts"),
  fetchedAt: ts("fetched_at").notNull(),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Scan = typeof scans.$inferSelect;
export type ImageRow = typeof images.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type Valuation = typeof valuations.$inferSelect;

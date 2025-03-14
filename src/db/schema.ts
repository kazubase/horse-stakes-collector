import { pgTable, text, serial, integer, timestamp, decimal, json ,varchar, numeric, bigint, boolean, index} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const horses = pgTable("horses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull(),
  frame: integer("frame").notNull(),
  number: integer("number").notNull(),
  status: text("status").notNull().default("running"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const races = pgTable("races", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  venue: text("venue").notNull(),
  startTime: timestamp("start_time").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const bettingStrategies = pgTable("betting_strategies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  config: json("config").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  raceId: bigint("race_id", { mode: "number" }).notNull(),
  betType: varchar('bet_type', { length: 20 }).notNull(),
  selections: json("selections").notNull(),
  totalStake: decimal("total_stake").notNull(),
  potentialReturn: decimal("potential_return").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const tanOddsHistory = pgTable("tan_odds_history", {
  id: serial("id").primaryKey(),
  horseId: bigint("horse_id", { mode: "number" }).notNull(),
  odds: numeric("odds").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull()
}, (table) => ({
  horseIdx: index("tan_odds_history_horse_id_idx").on(table.horseId),
  timestampIdx: index("tan_odds_history_timestamp_idx").on(table.timestamp),
  raceIdx: index("tan_odds_history_race_id_idx").on(table.raceId)
}));

export const fukuOdds = pgTable("fuku_odds", {
  id: serial("id").primaryKey(),
  horseId: bigint("horse_id", { mode: "number" }).notNull(),
  oddsMin: numeric("odds_min").notNull(),
  oddsMax: numeric("odds_max").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull()
}, (table) => ({
  horseIdx: index("fuku_odds_horse_id_idx").on(table.horseId),
  raceIdx: index("fuku_odds_race_id_idx").on(table.raceId)
}));

export const wakurenOdds = pgTable("wakuren_odds", {
  id: serial("id").primaryKey(),
  frame1: integer("frame1").notNull(),
  frame2: integer("frame2").notNull(),
  odds: numeric("odds").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull()
}, (table) => ({
  raceIdx: index("wakuren_odds_race_id_idx").on(table.raceId),
  framesIdx: index("wakuren_odds_frames_idx").on(table.frame1, table.frame2)
}));

export const umarenOdds = pgTable("umaren_odds", {
  id: serial("id").primaryKey(),
  horse1: integer("horse1").notNull(),
  horse2: integer("horse2").notNull(),
  odds: numeric("odds").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull()
}, (table) => ({
  raceIdx: index("umaren_odds_race_id_idx").on(table.raceId),
  horsesIdx: index("umaren_odds_horses_idx").on(table.horse1, table.horse2)
}));

export const betTypes = pgTable('bet_types', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 20 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  description: text('description'),
  requiredHorses: integer('required_horses').notNull(),
  orderMatters: boolean('order_matters').notNull(),
});

export const wideOdds = pgTable("wide_odds", {
  id: serial("id").primaryKey(),
  horse1: integer("horse1").notNull(),
  horse2: integer("horse2").notNull(),
  oddsMin: numeric("odds_min").notNull(),
  oddsMax: numeric("odds_max").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull()
}, (table) => ({
  raceIdx: index("wide_odds_race_id_idx").on(table.raceId),
  horsesIdx: index("wide_odds_horses_idx").on(table.horse1, table.horse2)
}));

export const umatanOdds = pgTable("umatan_odds", {
  id: serial("id").primaryKey(),
  horse1: integer("horse1").notNull(),
  horse2: integer("horse2").notNull(),
  odds: numeric("odds").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull()
}, (table) => ({
  raceIdx: index("umatan_odds_race_id_idx").on(table.raceId),
  horsesIdx: index("umatan_odds_horses_idx").on(table.horse1, table.horse2)
}));

export const fuku3Odds = pgTable("fuku3_odds", {
  id: serial("id").primaryKey(),
  horse1: integer("horse1").notNull(),
  horse2: integer("horse2").notNull(),
  horse3: integer("horse3").notNull(),
  odds: numeric("odds").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull()
}, (table) => ({
  raceIdx: index("fuku3_odds_race_id_idx").on(table.raceId),
  horsesIdx: index("fuku3_odds_horses_idx").on(table.horse1, table.horse2, table.horse3)
}));

export const tan3Odds = pgTable("tan3_odds", {
  id: serial("id").primaryKey(),
  horse1: integer("horse1").notNull(),
  horse2: integer("horse2").notNull(),
  horse3: integer("horse3").notNull(),
  odds: numeric("odds").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  raceId: bigint("race_id", { mode: "number" }).notNull()
}, (table) => ({
  raceIdx: index("tan3_odds_race_id_idx").on(table.raceId),
  horsesIdx: index("tan3_odds_horses_idx").on(table.horse1, table.horse2, table.horse3)
}));

export type Horse = typeof horses.$inferSelect;
export type Race = typeof races.$inferSelect;
export type BettingStrategy = typeof bettingStrategies.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type TanOddsHistory = typeof tanOddsHistory.$inferSelect;
export type FukuOdds = typeof fukuOdds.$inferSelect;
export type WakurenOdds = typeof wakurenOdds.$inferSelect;
export type UmarenOdds = typeof umarenOdds.$inferSelect;
export type WideOdds = typeof wideOdds.$inferSelect;
export type UmatanOdds = typeof umatanOdds.$inferSelect;
export type Fuku3Odds = typeof fuku3Odds.$inferSelect;
export type Tan3Odds = typeof tan3Odds.$inferSelect;
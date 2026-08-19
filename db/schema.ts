import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const siweNonces = sqliteTable(
  "siwe_nonces",
  {
    nonce: text("nonce").primaryKey(),
    domain: text("domain").notNull(),
    uri: text("uri").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("siwe_nonces_expires_at_idx").on(table.expiresAt)],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    walletAddress: text("wallet_address").notNull(),
    chainId: integer("chain_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("auth_sessions_wallet_idx").on(table.walletAddress),
    index("auth_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const notificationPreferences = sqliteTable("notification_preferences", {
  walletAddress: text("wallet_address").primaryKey(),
  email: text("email").notNull(),
  invoiceEmails: integer("invoice_emails", { mode: "boolean" }).notNull().default(false),
  receiptEmails: integer("receipt_emails", { mode: "boolean" }).notNull().default(false),
  verificationStatus: text("verification_status", { enum: ["pending", "verified"] })
    .notNull()
    .default("pending"),
  verifiedAt: text("verified_at"),
  updatedAt: text("updated_at").notNull(),
  retentionExpiresAt: text("retention_expires_at").notNull(),
});

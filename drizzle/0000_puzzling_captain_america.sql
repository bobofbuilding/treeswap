CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`wallet_address` text NOT NULL,
	`chain_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_wallet_idx` ON `auth_sessions` (`wallet_address`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expires_at_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`wallet_address` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`invoice_emails` integer DEFAULT false NOT NULL,
	`receipt_emails` integer DEFAULT false NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`verified_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `siwe_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`uri` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `siwe_nonces_expires_at_idx` ON `siwe_nonces` (`expires_at`);
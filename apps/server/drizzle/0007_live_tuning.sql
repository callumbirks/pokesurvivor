CREATE TABLE "config_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"overrides" jsonb NOT NULL,
	"created_by" uuid,
	"note" text,
	"reverted_from" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Version 0: the built-in defaults (no overrides). Runs from before live tuning played with them.
INSERT INTO "config_versions" ("id", "overrides", "note") VALUES (0, '{}', 'Built-in defaults');--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "config_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_config_version_config_versions_id_fk" FOREIGN KEY ("config_version") REFERENCES "public"."config_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_config_version_idx" ON "runs" USING btree ("config_version");
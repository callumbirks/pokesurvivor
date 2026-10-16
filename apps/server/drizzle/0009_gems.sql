ALTER TYPE "public"."currency" ADD VALUE 'gems';--> statement-breakpoint
ALTER TABLE "run_players" ADD COLUMN "gems" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "saves" ADD COLUMN "gems" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "saves" ADD CONSTRAINT "saves_gems_non_negative" CHECK ("saves"."gems" >= 0);
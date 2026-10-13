ALTER TABLE "run_players" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "checkpoint_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "timed_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_checkpoint_idx" ON "runs" USING btree ("checkpoint_at") WHERE "runs"."status" = 'started';
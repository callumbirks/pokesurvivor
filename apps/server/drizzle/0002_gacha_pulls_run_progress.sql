CREATE TABLE "gacha_pulls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"banner" text NOT NULL,
	"count" smallint NOT NULL,
	"pay_with" text NOT NULL,
	"cost" integer NOT NULL,
	"pity_before" integer NOT NULL,
	"pity_after" integer NOT NULL,
	"results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_players" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "gacha_pulls" ADD CONSTRAINT "gacha_pulls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gacha_pulls_user_id_idx" ON "gacha_pulls" USING btree ("user_id","created_at");
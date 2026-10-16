CREATE TABLE "run_balance" (
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" smallint NOT NULL,
	"source" text NOT NULL,
	"record" jsonb NOT NULL,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_balance_run_id_user_id_pk" PRIMARY KEY("run_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "run_balance" ADD CONSTRAINT "run_balance_run_id_user_id_run_players_run_id_user_id_fk" FOREIGN KEY ("run_id","user_id") REFERENCES "public"."run_players"("run_id","user_id") ON DELETE cascade ON UPDATE no action;
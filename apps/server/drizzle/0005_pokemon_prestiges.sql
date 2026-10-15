CREATE TABLE "pokemon_prestiges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"dex" integer NOT NULL,
	"stars" smallint NOT NULL,
	"reset" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pokemon_prestiges_stars_positive" CHECK ("pokemon_prestiges"."stars" >= 1)
);
--> statement-breakpoint
ALTER TABLE "pokemon_prestiges" ADD CONSTRAINT "pokemon_prestiges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pokemon_prestiges_user_id_idx" ON "pokemon_prestiges" USING btree ("user_id","dex");
CREATE TABLE "game_room_members" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" uuid,
	"handoff" jsonb,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP TABLE "room_restart_state" CASCADE;--> statement-breakpoint
ALTER TABLE "game_room_members" ADD CONSTRAINT "game_room_members_room_id_game_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."game_rooms"("id") ON DELETE cascade ON UPDATE no action;
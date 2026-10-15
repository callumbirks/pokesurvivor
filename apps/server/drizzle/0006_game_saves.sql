CREATE TABLE "game_saves" (
	"game_id" uuid PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"version" smallint NOT NULL,
	"game" jsonb NOT NULL,
	"sim" text NOT NULL,
	"build" text,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "room_restart_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"format" integer NOT NULL,
	"rooms" jsonb NOT NULL
);

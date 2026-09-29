CREATE TABLE "mock_complex" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"microdistrict" text,
	"district" text,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"developer" text,
	"price_from" integer,
	"grocery" boolean DEFAULT false NOT NULL,
	"blurb" text,
	"tags" jsonb NOT NULL,
	"reviews" jsonb NOT NULL,
	"src" jsonb NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);

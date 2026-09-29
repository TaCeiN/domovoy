CREATE TABLE "mock_complex_photo" (
	"slug" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"mime" text NOT NULL,
	"credit" text NOT NULL,
	"source_url" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mock_complex_photo" ADD CONSTRAINT "mock_complex_photo_slug_mock_complex_slug_fk" FOREIGN KEY ("slug") REFERENCES "public"."mock_complex"("slug") ON DELETE cascade ON UPDATE no action;
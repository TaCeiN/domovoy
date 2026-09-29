CREATE TABLE "bill_bringer" (
	"bill_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_bringer_bill_id_user_id_pk" PRIMARY KEY("bill_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "meter" ADD COLUMN "place" text;--> statement-breakpoint
ALTER TABLE "meter" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "bill_bringer" ADD CONSTRAINT "bill_bringer_bill_id_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_bringer" ADD CONSTRAINT "bill_bringer_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter" ADD CONSTRAINT "meter_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
CREATE TABLE "organization_gateway_key" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"preview" text NOT NULL,
	"created_by" uuid,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "key_source" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_gateway_key" ADD CONSTRAINT "organization_gateway_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_gateway_key" ADD CONSTRAINT "organization_gateway_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_key_source_check" CHECK ("usage_event"."key_source" in ('system', 'own'));
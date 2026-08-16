CREATE TABLE "organization_draft" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"seats" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_draft_type_check" CHECK ("organization_draft"."type" in ('team', 'enterprise')),
	CONSTRAINT "organization_draft_seats_check" CHECK ("organization_draft"."seats" >= 1),
	CONSTRAINT "organization_draft_status_check" CHECK ("organization_draft"."status" in ('pending', 'completed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "stripe_mock_object" (
	"id" text PRIMARY KEY NOT NULL,
	"object" text NOT NULL,
	"customer_id" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"plan" text NOT NULL,
	"reference_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"trial_start" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"seats" integer,
	"billing_interval" text,
	"stripe_schedule_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "organization_draft" ADD CONSTRAINT "organization_draft_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_draft_userId_idx" ON "organization_draft" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stripe_mock_object_object_customerId_idx" ON "stripe_mock_object" USING btree ("object","customer_id");--> statement-breakpoint
CREATE INDEX "subscription_referenceId_idx" ON "subscription" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "subscription_stripeSubscriptionId_idx" ON "subscription" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_stripeCustomerId_idx" ON "subscription" USING btree ("stripe_customer_id");
CREATE TABLE "credit_account" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"lifetime_topped_up" bigint DEFAULT 0 NOT NULL,
	"lifetime_spent" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_account_balance_check" CHECK ("credit_account"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_topup" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"credit_amount" bigint NOT NULL,
	"charge_amount" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"fee_rate_bps" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_session_id" text,
	"stripe_payment_intent_id" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_topup_stripe_session_id_unique" UNIQUE("stripe_session_id"),
	CONSTRAINT "credit_topup_credit_amount_check" CHECK ("credit_topup"."credit_amount" > 0),
	CONSTRAINT "credit_topup_charge_amount_check" CHECK ("credit_topup"."charge_amount" > 0),
	CONSTRAINT "credit_topup_fee_rate_check" CHECK ("credit_topup"."fee_rate_bps" >= 0),
	CONSTRAINT "credit_topup_status_check" CHECK ("credit_topup"."status" in ('pending', 'paid', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "credit_transaction" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reference_id" uuid,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transaction_kind_check" CHECK ("credit_transaction"."kind" in ('topup', 'usage', 'refund', 'adjustment')),
	CONSTRAINT "credit_transaction_amount_check" CHECK (case
            when "credit_transaction"."kind" in ('topup', 'refund') then "credit_transaction"."amount" > 0
            when "credit_transaction"."kind" = 'usage' then "credit_transaction"."amount" < 0
            else "credit_transaction"."amount" <> 0
          end)
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"asset_id" uuid,
	"transaction_id" uuid,
	"purpose" text NOT NULL,
	"modality" text,
	"model" text NOT NULL,
	"gateway_model" text,
	"status" text NOT NULL,
	"error" text,
	"unit" text,
	"quantity" double precision,
	"charged_amount" bigint DEFAULT 0 NOT NULL,
	"upstream_cost" bigint,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_event_status_check" CHECK ("usage_event"."status" in ('succeeded', 'failed')),
	CONSTRAINT "usage_event_purpose_check" CHECK ("usage_event"."purpose" in ('generation', 'title'))
);
--> statement-breakpoint
ALTER TABLE "credit_account" ADD CONSTRAINT "credit_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_topup" ADD CONSTRAINT "credit_topup_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_topup" ADD CONSTRAINT "credit_topup_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transaction" ADD CONSTRAINT "credit_transaction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transaction" ADD CONSTRAINT "credit_transaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_transaction_id_credit_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."credit_transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_topup_organizationId_createdAt_idx" ON "credit_topup" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_transaction_organizationId_createdAt_idx" ON "credit_transaction" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transaction_kind_reference_idx" ON "credit_transaction" USING btree ("kind","reference_id") WHERE "credit_transaction"."reference_id" is not null;--> statement-breakpoint
CREATE INDEX "usage_event_organizationId_createdAt_idx" ON "usage_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_event_userId_createdAt_idx" ON "usage_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_event_assetId_idx" ON "usage_event" USING btree ("asset_id");
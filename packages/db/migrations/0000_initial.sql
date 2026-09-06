CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"max_machines" integer NOT NULL,
	"max_hourly_micro_eur" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_limits" CHECK ("accounts"."max_machines" >= 0 AND "accounts"."max_hourly_micro_eur" >= 0)
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"provider" text NOT NULL,
	"server_id" text,
	"hourly_micro_eur" integer NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocations_provider_server_id_unique" UNIQUE("provider","server_id"),
	CONSTRAINT "allocation_price" CHECK ("allocations"."hourly_micro_eur" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"command" jsonb NOT NULL,
	"outcome" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_attempts_operation_id_sequence_unique" UNIQUE("operation_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"event" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"policy" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "grants_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "idempotency" (
	"account_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"operation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_account_id_scope_key_unique" UNIQUE("account_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"provider" text NOT NULL,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_account_id_project_id_id_unique" UNIQUE("account_id","project_id","id"),
	CONSTRAINT "machines_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "machine_version" CHECK ("machines"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"project_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"kind" text NOT NULL,
	"command" jsonb NOT NULL,
	"progress" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "projects_account_id_name_unique" UNIQUE("account_id","name")
);
--> statement-breakpoint
CREATE TABLE "simulated_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"command" jsonb NOT NULL,
	"server_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"ready_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulated_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"visible_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_account_id_machine_id_machines_account_id_id_fk" FOREIGN KEY ("account_id","machine_id") REFERENCES "public"."machines"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_attempts" ADD CONSTRAINT "provider_attempts_account_id_operation_id_operations_account_id_id_fk" FOREIGN KEY ("account_id","operation_id") REFERENCES "public"."operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_account_id_parent_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","parent_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency" ADD CONSTRAINT "idempotency_account_id_operation_id_operations_account_id_id_fk" FOREIGN KEY ("account_id","operation_id") REFERENCES "public"."operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_account_id_project_id_projects_account_id_id_fk" FOREIGN KEY ("account_id","project_id") REFERENCES "public"."projects"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_account_id_project_id_machine_id_machines_account_id_project_id_id_fk" FOREIGN KEY ("account_id","project_id","machine_id") REFERENCES "public"."machines"("account_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_account_id_grant_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_live_allocation" ON "allocations" USING btree ("machine_id") WHERE "allocations"."retired_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "live_machine_name" ON "machines" USING btree ("project_id","name") WHERE "machines"."state"->>'kind' <> 'destroyed';--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_operation" ON "operations" USING btree ("machine_id") WHERE "operations"."progress"->>'kind' NOT IN ('succeeded', 'failed');
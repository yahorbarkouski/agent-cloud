CREATE TABLE "backup_schedule_runs" (
	"account_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"backup_id" text PRIMARY KEY NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "backup_schedule_runs_schedule_id_due_at_unique" UNIQUE("schedule_id","due_at")
);
--> statement-breakpoint
CREATE TABLE "backup_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"project_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"digest" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone,
	"last_attempt" jsonb DEFAULT '{"kind":"none"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_schedules_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
ALTER TABLE "backup_schedule_runs" ADD CONSTRAINT "backup_schedule_runs_account_id_schedule_id_backup_schedules_account_id_id_fk" FOREIGN KEY ("account_id","schedule_id") REFERENCES "public"."backup_schedules"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_schedule_runs" ADD CONSTRAINT "backup_schedule_runs_account_id_backup_id_backups_account_id_id_fk" FOREIGN KEY ("account_id","backup_id") REFERENCES "public"."backups"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_account_id_project_id_projects_account_id_id_fk" FOREIGN KEY ("account_id","project_id") REFERENCES "public"."projects"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_account_id_machine_id_machines_account_id_id_fk" FOREIGN KEY ("account_id","machine_id") REFERENCES "public"."machines"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_account_id_allocation_id_allocations_account_id_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."allocations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_account_id_grant_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_schedule_active_app" ON "backup_schedules" USING btree ("machine_id",("recipe"->>'app')) WHERE "backup_schedules"."disabled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "backup_schedule_due" ON "backup_schedules" USING btree ("next_run_at") WHERE "backup_schedules"."disabled_at" IS NULL;
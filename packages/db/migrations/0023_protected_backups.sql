CREATE TABLE "backup_restores" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"backup_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"digest" text NOT NULL,
	"request" jsonb NOT NULL,
	"record" jsonb NOT NULL,
	"work" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_restores_machine_id_unique" UNIQUE("machine_id")
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"project_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"digest" text NOT NULL,
	"request" jsonb NOT NULL,
	"record" jsonb NOT NULL,
	"work" jsonb NOT NULL,
	"reserved_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backups_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "backup_reserved_bytes_bound" CHECK ("backups"."reserved_bytes" BETWEEN 0 AND 1073741824)
);
--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_account_id_backup_id_backups_account_id_id_fk" FOREIGN KEY ("account_id","backup_id") REFERENCES "public"."backups"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_account_id_machine_id_machines_account_id_id_fk" FOREIGN KEY ("account_id","machine_id") REFERENCES "public"."machines"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_account_id_grant_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_account_id_project_id_projects_account_id_id_fk" FOREIGN KEY ("account_id","project_id") REFERENCES "public"."projects"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_account_id_machine_id_machines_account_id_id_fk" FOREIGN KEY ("account_id","machine_id") REFERENCES "public"."machines"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_account_id_allocation_id_allocations_account_id_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."allocations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_account_id_grant_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_restores_account_time" ON "backup_restores" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "backups_account_time" ON "backups" USING btree ("account_id","created_at");
CREATE TABLE "backup_purges" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"backup_id" text NOT NULL,
	"grant_id" text,
	"record" jsonb NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_purges_backup_id_unique" UNIQUE("backup_id")
);
--> statement-breakpoint
ALTER TABLE "backup_purges" ADD CONSTRAINT "backup_purges_account_id_backup_id_backups_account_id_id_fk" FOREIGN KEY ("account_id","backup_id") REFERENCES "public"."backups"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_purges" ADD CONSTRAINT "backup_purges_account_id_grant_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_purges_due" ON "backup_purges" USING btree ("next_attempt_at") WHERE "backup_purges"."next_attempt_at" IS NOT NULL;
CREATE TABLE "domain_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"hostname" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hosting_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"hostname" text NOT NULL,
	"digest" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosting_routes" (
	"hostname" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"project_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"record" jsonb NOT NULL,
	"target" jsonb,
	CONSTRAINT "hosting_routes_account_id_hostname_unique" UNIQUE("account_id","hostname")
);
--> statement-breakpoint
ALTER TABLE "domain_challenges" ADD CONSTRAINT "domain_challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_commands" ADD CONSTRAINT "hosting_commands_account_id_hostname_hosting_routes_account_id_hostname_fk" FOREIGN KEY ("account_id","hostname") REFERENCES "public"."hosting_routes"("account_id","hostname") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_routes" ADD CONSTRAINT "hosting_routes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_routes" ADD CONSTRAINT "hosting_routes_account_id_project_id_projects_account_id_id_fk" FOREIGN KEY ("account_id","project_id") REFERENCES "public"."projects"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_routes" ADD CONSTRAINT "hosting_routes_account_id_machine_id_machines_account_id_id_fk" FOREIGN KEY ("account_id","machine_id") REFERENCES "public"."machines"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_challenges_account" ON "domain_challenges" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "hosting_routes_machine" ON "hosting_routes" USING btree ("machine_id");
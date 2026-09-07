CREATE TABLE "customer_identities" (
	"github_user_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"anchor_grant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_identities_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "customer_identities_anchor_grant_id_unique" UNIQUE("anchor_grant_id"),
	CONSTRAINT "customer_identities_github_user_id_account_id_unique" UNIQUE("github_user_id","account_id"),
	CONSTRAINT "github_user_id_format" CHECK ("customer_identities"."github_user_id" ~ '^[1-9][0-9]{0,19}$')
);
--> statement-breakpoint
CREATE TABLE "customer_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"github_user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_logins_grant_id_unique" UNIQUE("grant_id")
);
--> statement-breakpoint
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_account_id_anchor_grant_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","anchor_grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_logins" ADD CONSTRAINT "customer_logins_github_user_id_account_id_customer_identities_github_user_id_account_id_fk" FOREIGN KEY ("github_user_id","account_id") REFERENCES "public"."customer_identities"("github_user_id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_logins" ADD CONSTRAINT "customer_logins_account_id_grant_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;
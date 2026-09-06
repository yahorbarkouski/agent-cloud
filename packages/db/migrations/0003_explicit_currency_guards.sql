-- Referenced uniqueness must exist before the composite foreign key.
ALTER TABLE "accounts" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "allocations" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "account_currency_identity" UNIQUE("id","currency");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocation_account_currency" FOREIGN KEY ("account_id","currency") REFERENCES "public"."accounts"("id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "account_currency_format" CHECK ("accounts"."currency" ~ '^[A-Z]{3}$');

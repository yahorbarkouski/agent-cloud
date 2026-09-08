CREATE TABLE "allocation_reservations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"kind" text NOT NULL,
	"hourly_micros" integer NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "allocation_reservation_kind" CHECK ("allocation_reservations"."kind" IN ('admitted', 'changed', 'released', 'baseline')),
	CONSTRAINT "allocation_reservation_price" CHECK ("allocation_reservations"."hourly_micros" >= 0 AND ("allocation_reservations"."kind" <> 'released' OR "allocation_reservations"."hourly_micros" = 0))
);
--> statement-breakpoint
ALTER TABLE "allocation_reservations" ADD CONSTRAINT "allocation_reservations_account_id_machine_id_allocation_id_allocations_account_id_machine_id_id_fk" FOREIGN KEY ("account_id","machine_id","allocation_id") REFERENCES "public"."allocations"("account_id","machine_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocation_reservation_history" ON "allocation_reservations" USING btree ("account_id","id");
--> statement-breakpoint
-- Existing mutable rates are known only at migration time, never retroactively.
INSERT INTO allocation_reservations (account_id, machine_id, allocation_id, kind, hourly_micros, currency)
SELECT account_id, machine_id, id, 'baseline', CASE WHEN retired_at IS NULL THEN hourly_micros ELSE 0 END, currency
FROM allocations;
--> statement-breakpoint
CREATE FUNCTION record_allocation_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.hourly_micros IS NOT DISTINCT FROM OLD.hourly_micros
    AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at THEN
    RETURN NEW;
  END IF;
  INSERT INTO allocation_reservations (account_id, machine_id, allocation_id, kind, hourly_micros, currency)
  VALUES (NEW.account_id, NEW.machine_id, NEW.id,
    CASE WHEN NEW.retired_at IS NOT NULL THEN 'released' WHEN TG_OP = 'INSERT' THEN 'admitted' ELSE 'changed' END,
    CASE WHEN NEW.retired_at IS NULL THEN NEW.hourly_micros ELSE 0 END, NEW.currency);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER record_allocation_reservation AFTER INSERT OR UPDATE ON allocations
FOR EACH ROW EXECUTE FUNCTION record_allocation_reservation();
--> statement-breakpoint
CREATE FUNCTION preserve_allocation_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Allocation reservation history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER preserve_allocation_reservation BEFORE UPDATE OR DELETE ON allocation_reservations
FOR EACH ROW EXECUTE FUNCTION preserve_allocation_reservation();

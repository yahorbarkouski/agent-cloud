-- Keep the provider identity exclusion when an existing customer record changes identity.
CREATE OR REPLACE TRIGGER customer_provider_resource_scope_guard
BEFORE INSERT OR UPDATE OF provider, kind, provider_id ON provider_resources
FOR EACH ROW EXECUTE FUNCTION guard_provider_resource_scope();

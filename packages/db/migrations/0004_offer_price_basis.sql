-- Earlier records preserved an aggregate estimate, not an observed VM/IP breakdown.
-- Keep their total and physical mapping, but identify the reconstructed components.
UPDATE allocations SET offer = offer || '{"priceBasis":"legacy_estimate"}'::jsonb
WHERE offer IS NOT NULL AND NOT (offer ? 'priceBasis');
--> statement-breakpoint
UPDATE operations SET offer = offer || '{"priceBasis":"legacy_estimate"}'::jsonb
WHERE offer IS NOT NULL AND NOT (offer ? 'priceBasis');

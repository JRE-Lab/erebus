ALTER TABLE "nodes" ADD COLUMN "probability" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
UPDATE "nodes" SET "probability" = LEAST(0.98, GREATEST(0.02, ("confirmation" + 1) / 2));--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "hypotheses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "resolved_outcome" boolean;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "resolved_source" text;
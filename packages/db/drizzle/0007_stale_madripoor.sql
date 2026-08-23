CREATE TABLE "loom_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url_canon" text NOT NULL,
	"outlet_id" uuid,
	"title" text,
	"lede" text,
	"text_hash" text,
	"lang" text,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gdelt_ref" text,
	"embedding" vector(1536),
	"narrative_id" uuid,
	CONSTRAINT "loom_articles_url_canon_unique" UNIQUE("url_canon")
);
--> statement-breakpoint
CREATE TABLE "loom_outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"country" text,
	"lang" text,
	"is_wire" boolean DEFAULT false NOT NULL,
	CONSTRAINT "loom_outlets_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "loom_wire_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wire_name" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"lede" text,
	"text_hash" text,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1536),
	CONSTRAINT "loom_wire_releases_url_unique" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "last_expanded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "expand_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loom_articles" ADD CONSTRAINT "loom_articles_outlet_id_loom_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."loom_outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loom_articles_first_seen_idx" ON "loom_articles" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "loom_articles_narrative_idx" ON "loom_articles" USING btree ("narrative_id");--> statement-breakpoint
CREATE INDEX "loom_articles_hash_idx" ON "loom_articles" USING btree ("text_hash");--> statement-breakpoint
CREATE INDEX "loom_wires_first_seen_idx" ON "loom_wire_releases" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "loom_wires_hash_idx" ON "loom_wire_releases" USING btree ("text_hash");--> statement-breakpoint
CREATE INDEX "alerts_seen_idx" ON "alerts" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "events_created_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_finished_idx" ON "exploration_jobs" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "jobs_target_idx" ON "exploration_jobs" USING btree ("target_node");--> statement-breakpoint
DELETE FROM "signal_matches" WHERE "effect" = 'neutral' AND "weight" = 0 AND ("rationale" IS NULL OR "rationale" = '');--> statement-breakpoint
DELETE FROM "signal_matches" a USING "signal_matches" b WHERE a."signal_id" = b."signal_id" AND a."node_id" = b."node_id" AND (a."created_at" > b."created_at" OR (a."created_at" = b."created_at" AND a."id" > b."id"));--> statement-breakpoint
CREATE UNIQUE INDEX "signal_matches_pair_uq" ON "signal_matches" USING btree ("signal_id","node_id");--> statement-breakpoint
CREATE INDEX "signals_ingested_idx" ON "signals" USING btree ("ingested_at");
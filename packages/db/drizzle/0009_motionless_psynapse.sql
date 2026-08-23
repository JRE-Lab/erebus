CREATE TABLE "loom_narrative_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"vel24" integer DEFAULT 0 NOT NULL,
	"vel6" integer DEFAULT 0 NOT NULL,
	"accel" real DEFAULT 0 NOT NULL,
	"reach_outlets" integer DEFAULT 0 NOT NULL,
	"reach_langs" integer DEFAULT 0 NOT NULL,
	"article_count" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_narrative_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_narratives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text,
	"label_attempts" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"state" text DEFAULT 'seeding' NOT NULL,
	"centroid" vector(1536) NOT NULL,
	"article_count" integer DEFAULT 0 NOT NULL,
	"outlet_count" integer DEFAULT 0 NOT NULL,
	"lang_count" integer DEFAULT 0 NOT NULL,
	"max_vel24" real DEFAULT 0 NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	"peak_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_state_change_at" timestamp with time zone,
	"model_ver" text
);
--> statement-breakpoint
ALTER TABLE "loom_narrative_metrics" ADD CONSTRAINT "loom_narrative_metrics_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_narrative_transitions" ADD CONSTRAINT "loom_narrative_transitions_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loom_metrics_narrative_ts_idx" ON "loom_narrative_metrics" USING btree ("narrative_id","ts");--> statement-breakpoint
CREATE INDEX "loom_transitions_narrative_idx" ON "loom_narrative_transitions" USING btree ("narrative_id");--> statement-breakpoint
CREATE INDEX "loom_narratives_state_idx" ON "loom_narratives" USING btree ("state");--> statement-breakpoint
CREATE INDEX "loom_narratives_last_seen_idx" ON "loom_narratives" USING btree ("last_seen_at");--> statement-breakpoint
ALTER TABLE "loom_articles" ADD CONSTRAINT "loom_articles_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE set null ON UPDATE no action;
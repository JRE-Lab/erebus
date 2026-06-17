CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text,
	"script" text,
	"audio_url" text,
	"video_url" text,
	"platform" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text,
	"round" integer,
	"proposer" text,
	"adversary" text,
	"synthesis" text,
	"verdict" text,
	"confidence_delta" real,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text,
	"kind" text,
	"cause_type" text,
	"cause_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exploration_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text,
	"target_node" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" real,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gardener_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text,
	"node_id" text,
	"related_node" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"outcome" text NOT NULL,
	"rationale" text,
	"indicators" text[] DEFAULT '{}' NOT NULL,
	"falsifiers" text[] DEFAULT '{}' NOT NULL,
	"horizon" timestamp with time zone,
	"branch_label" text,
	"parent_id" text,
	"synthesized_from" text[] DEFAULT '{}' NOT NULL,
	"confirmation" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"state" text DEFAULT 'speculative' NOT NULL,
	"resolved" boolean,
	"brier" real,
	"is_launch_point" boolean DEFAULT false NOT NULL,
	"domains" text[] DEFAULT '{}' NOT NULL,
	"embedding" vector(1536),
	"last_validated_at" timestamp with time zone,
	"merged_into" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_node" text,
	"to_node" text,
	"type" text NOT NULL,
	"strength" real DEFAULT 0.5 NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text,
	"revealed_preference" text,
	"cui_bono" text,
	"counter_narrative" text,
	"deception_indicators" text[] DEFAULT '{}' NOT NULL,
	"misdirection" text,
	"spawned_node" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid,
	"node_id" text,
	"effect" text NOT NULL,
	"weight" real DEFAULT 0.5 NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text,
	"url" text,
	"title" text,
	"summary" text,
	"dedup_hash" text,
	"published_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1536),
	CONSTRAINT "signals_dedup_hash_unique" UNIQUE("dedup_hash")
);
--> statement-breakpoint
CREATE TABLE "worldview_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"summary" text,
	"node_count" integer,
	"green_count" integer,
	"calibration_score" real,
	"novel_links" jsonb,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_jobs" ADD CONSTRAINT "exploration_jobs_target_node_nodes_id_fk" FOREIGN KEY ("target_node") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_merged_into_nodes_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_from_node_nodes_id_fk" FOREIGN KEY ("from_node") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_to_node_nodes_id_fk" FOREIGN KEY ("to_node") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_reads" ADD CONSTRAINT "shadow_reads_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_reads" ADD CONSTRAINT "shadow_reads_spawned_node_nodes_id_fk" FOREIGN KEY ("spawned_node") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_matches" ADD CONSTRAINT "signal_matches_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_matches" ADD CONSTRAINT "signal_matches_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_node_idx" ON "events" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "nodes_parent_idx" ON "nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "nodes_state_idx" ON "nodes" USING btree ("state");--> statement-breakpoint
CREATE INDEX "matches_node_idx" ON "signal_matches" USING btree ("node_id");
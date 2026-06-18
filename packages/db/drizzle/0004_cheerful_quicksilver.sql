CREATE TABLE "game_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text,
	"players" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"game_type" text,
	"predicted_equilibrium" text,
	"equilibrium_type" text,
	"outcome_is_equilibrium" boolean,
	"stability" real,
	"fragility_drivers" text[] DEFAULT '{}' NOT NULL,
	"focal_point" text,
	"leverage_moves" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_regret_action" text,
	"reversal_tripwire" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "stability" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "equilibrium_type" text;--> statement-breakpoint
ALTER TABLE "game_reads" ADD CONSTRAINT "game_reads_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_reads_node_idx" ON "game_reads" USING btree ("node_id");
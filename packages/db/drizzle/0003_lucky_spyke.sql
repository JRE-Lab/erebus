CREATE TABLE "node_instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"expectation" text DEFAULT 'up' NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_instruments" ADD CONSTRAINT "node_instruments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_instruments_node_idx" ON "node_instruments" USING btree ("node_id");
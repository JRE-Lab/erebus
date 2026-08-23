CREATE TABLE "loom_analogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"analog_narrative_id" uuid NOT NULL,
	"sim" real NOT NULL,
	"regime_match" boolean DEFAULT false NOT NULL,
	"outcome_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_negative_space" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"z" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_outlet_priors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"narratives" integer DEFAULT 0 NOT NULL,
	"first_mover_rate" real DEFAULT 0 NOT NULL,
	"wire_dependence" real DEFAULT 0 NOT NULL,
	"avg_lead_hours" real,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loom_playbooks" ADD COLUMN "last_matched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loom_playbooks" ADD COLUMN "decayed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loom_analogs" ADD CONSTRAINT "loom_analogs_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_analogs" ADD CONSTRAINT "loom_analogs_analog_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("analog_narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_negative_space" ADD CONSTRAINT "loom_negative_space_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_outlet_priors" ADD CONSTRAINT "loom_outlet_priors_outlet_id_loom_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."loom_outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loom_analogs_pair_uq" ON "loom_analogs" USING btree ("narrative_id","analog_narrative_id");--> statement-breakpoint
CREATE INDEX "loom_analogs_narrative_idx" ON "loom_analogs" USING btree ("narrative_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_negative_space_narrative_kind_uq" ON "loom_negative_space" USING btree ("narrative_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_outlet_priors_outlet_uq" ON "loom_outlet_priors" USING btree ("outlet_id");
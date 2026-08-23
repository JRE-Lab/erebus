CREATE TABLE "loom_beneficiaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"entity_id" uuid,
	"name" text NOT NULL,
	"rationale" text,
	"falsifier" text NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"canon_name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ticker" text,
	"cik" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_event_studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"car_pre" real,
	"car_event" real,
	"car_post" real,
	"model_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consistency" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_exposures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"weight" real NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"claim_type" text NOT NULL,
	"target_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"direction" text,
	"magnitude_band" text,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"prob" real NOT NULL,
	"regime_at_issue" text,
	"model_ver" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_framing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"protagonist" text,
	"antagonist" text,
	"threat" text,
	"remedy" text,
	"urgency" text,
	"implied_action" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loom_framing_article_id_unique" UNIQUE("article_id")
);
--> statement-breakpoint
CREATE TABLE "loom_hypotheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"code" text NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loom_instruments_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "loom_judgments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"top_h" text NOT NULL,
	"top_band" text NOT NULL,
	"runner_h" text NOT NULL,
	"runner_band" text NOT NULL,
	"confidence" text NOT NULL,
	"falsifiers" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_narrative_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"salience" real DEFAULT 0.5 NOT NULL,
	"sentiment" real
);
--> statement-breakpoint
CREATE TABLE "loom_placebo_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"regime_state" text NOT NULL,
	"samples" integer NOT NULL,
	"mean" real NOT NULL,
	"sd" real NOT NULL,
	"quantiles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_playbook_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"narrative_id" uuid NOT NULL,
	"match_score" real NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"theory_ref" text NOT NULL,
	"outcome_desc" text NOT NULL,
	"pattern" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_positioning" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"date" date NOT NULL,
	"vol_z" real,
	"resid_ret" real,
	"insider_score" real,
	"si_delta_pctl" real
);
--> statement-breakpoint
CREATE TABLE "loom_preposition_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"composite" real NOT NULL,
	"detectors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"placebo_pctl" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"date" date NOT NULL,
	"open" double precision,
	"high" double precision,
	"low" double precision,
	"close" double precision NOT NULL,
	"volume" double precision
);
--> statement-breakpoint
CREATE TABLE "loom_regimes" (
	"date" date PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"vix" real,
	"vix_trend" real,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"forecast_id" uuid NOT NULL,
	"outcome" boolean NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"brier" real NOT NULL,
	CONSTRAINT "loom_resolutions_forecast_id_unique" UNIQUE("forecast_id")
);
--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "frame" jsonb;--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "coordination_score" real;--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "coord_ci_low" real;--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "coord_ci_high" real;--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "wire_share_pct" real;--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "first_mover_outlet" text;--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "ach_scored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "ach_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loom_narratives" ADD COLUMN "entities_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loom_beneficiaries" ADD CONSTRAINT "loom_beneficiaries_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_beneficiaries" ADD CONSTRAINT "loom_beneficiaries_entity_id_loom_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."loom_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_event_studies" ADD CONSTRAINT "loom_event_studies_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_event_studies" ADD CONSTRAINT "loom_event_studies_instrument_id_loom_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."loom_instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_evidence" ADD CONSTRAINT "loom_evidence_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_exposures" ADD CONSTRAINT "loom_exposures_entity_id_loom_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."loom_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_exposures" ADD CONSTRAINT "loom_exposures_instrument_id_loom_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."loom_instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_forecasts" ADD CONSTRAINT "loom_forecasts_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_framing" ADD CONSTRAINT "loom_framing_article_id_loom_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."loom_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_hypotheses" ADD CONSTRAINT "loom_hypotheses_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_judgments" ADD CONSTRAINT "loom_judgments_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_narrative_entities" ADD CONSTRAINT "loom_narrative_entities_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_narrative_entities" ADD CONSTRAINT "loom_narrative_entities_entity_id_loom_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."loom_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_playbook_matches" ADD CONSTRAINT "loom_playbook_matches_playbook_id_loom_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."loom_playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_playbook_matches" ADD CONSTRAINT "loom_playbook_matches_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_positioning" ADD CONSTRAINT "loom_positioning_instrument_id_loom_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."loom_instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_preposition_flags" ADD CONSTRAINT "loom_preposition_flags_narrative_id_loom_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."loom_narratives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_preposition_flags" ADD CONSTRAINT "loom_preposition_flags_instrument_id_loom_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."loom_instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_prices" ADD CONSTRAINT "loom_prices_instrument_id_loom_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."loom_instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loom_resolutions" ADD CONSTRAINT "loom_resolutions_forecast_id_loom_forecasts_id_fk" FOREIGN KEY ("forecast_id") REFERENCES "public"."loom_forecasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loom_beneficiaries_narrative_idx" ON "loom_beneficiaries" USING btree ("narrative_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_entities_kind_name_uq" ON "loom_entities" USING btree ("kind","canon_name");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_event_studies_pair_uq" ON "loom_event_studies" USING btree ("narrative_id","instrument_id");--> statement-breakpoint
CREATE INDEX "loom_evidence_narrative_idx" ON "loom_evidence" USING btree ("narrative_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_exposures_pair_uq" ON "loom_exposures" USING btree ("entity_id","instrument_id");--> statement-breakpoint
CREATE INDEX "loom_forecasts_narrative_idx" ON "loom_forecasts" USING btree ("narrative_id","issued_at");--> statement-breakpoint
CREATE INDEX "loom_forecasts_window_end_idx" ON "loom_forecasts" USING btree ("window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_hypotheses_pair_uq" ON "loom_hypotheses" USING btree ("narrative_id","code");--> statement-breakpoint
CREATE INDEX "loom_judgments_narrative_idx" ON "loom_judgments" USING btree ("narrative_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_narr_entities_pair_uq" ON "loom_narrative_entities" USING btree ("narrative_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_playbook_matches_pair_uq" ON "loom_playbook_matches" USING btree ("playbook_id","narrative_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_positioning_inst_date_uq" ON "loom_positioning" USING btree ("instrument_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_preposition_pair_uq" ON "loom_preposition_flags" USING btree ("narrative_id","instrument_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_prices_inst_date_uq" ON "loom_prices" USING btree ("instrument_id","date");--> statement-breakpoint
CREATE INDEX "loom_resolutions_resolved_idx" ON "loom_resolutions" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "loom_wires_title_lower_idx" ON "loom_wire_releases" USING btree (lower("title"));
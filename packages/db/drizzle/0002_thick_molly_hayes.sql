ALTER TABLE "content_items" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;
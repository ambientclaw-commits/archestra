CREATE TABLE "github_app_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"github_url" text DEFAULT 'https://api.github.com' NOT NULL,
	"app_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"secret_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_app_configs" ADD CONSTRAINT "github_app_configs_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_app_configs_organization_id_idx" ON "github_app_configs" USING btree ("organization_id");
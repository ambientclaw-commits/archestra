CREATE TABLE "llm_routers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar(256) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cheap_model_id" uuid,
	"cheap_api_key_id" uuid,
	"premium_model_id" uuid,
	"premium_api_key_id" uuid,
	"mode" text DEFAULT 'balanced' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "llm_router_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_routers" ADD CONSTRAINT "llm_routers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "llm_routers" VALIDATE CONSTRAINT "llm_routers_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "llm_routers" ADD CONSTRAINT "llm_routers_cheap_model_id_models_id_fk" FOREIGN KEY ("cheap_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "llm_routers" VALIDATE CONSTRAINT "llm_routers_cheap_model_id_models_id_fk";--> statement-breakpoint
ALTER TABLE "llm_routers" ADD CONSTRAINT "llm_routers_cheap_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("cheap_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "llm_routers" VALIDATE CONSTRAINT "llm_routers_cheap_api_key_id_chat_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "llm_routers" ADD CONSTRAINT "llm_routers_premium_model_id_models_id_fk" FOREIGN KEY ("premium_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "llm_routers" VALIDATE CONSTRAINT "llm_routers_premium_model_id_models_id_fk";--> statement-breakpoint
ALTER TABLE "llm_routers" ADD CONSTRAINT "llm_routers_premium_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("premium_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "llm_routers" VALIDATE CONSTRAINT "llm_routers_premium_api_key_id_chat_api_keys_id_fk";--> statement-breakpoint
CREATE INDEX "llm_routers_organization_id_idx" ON "llm_routers" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_llm_router_id_llm_routers_id_fk" FOREIGN KEY ("llm_router_id") REFERENCES "public"."llm_routers"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_llm_router_id_llm_routers_id_fk";

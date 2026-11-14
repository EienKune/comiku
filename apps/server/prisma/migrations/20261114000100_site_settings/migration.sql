CREATE TABLE "site_settings" (
    "id" VARCHAR(20) NOT NULL DEFAULT 'global',
    "name" VARCHAR(128) NOT NULL DEFAULT 'Comiku',
    "theme_preset_id" VARCHAR(32) NOT NULL DEFAULT 'teal',
    "icon_asset_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "site_brand_assets" (
    "id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "icon_file_id" UUID NOT NULL,
    "favicon_file_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'preparing',
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_brand_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "site_settings_icon_asset_id_key" ON "site_settings"("icon_asset_id");

CREATE UNIQUE INDEX "site_brand_assets_icon_file_id_key" ON "site_brand_assets"("icon_file_id");

CREATE UNIQUE INDEX "site_brand_assets_favicon_file_id_key" ON "site_brand_assets"("favicon_file_id");

CREATE INDEX "site_brand_assets_expires_at_id_idx" ON "site_brand_assets"("expires_at", "id");

ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_icon_asset_id_fkey" FOREIGN KEY ("icon_asset_id") REFERENCES "site_brand_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_brand_assets" ADD CONSTRAINT "site_brand_assets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_brand_assets" ADD CONSTRAINT "site_brand_assets_icon_file_id_fkey" FOREIGN KEY ("icon_file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_brand_assets" ADD CONSTRAINT "site_brand_assets_favicon_file_id_fkey" FOREIGN KEY ("favicon_file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

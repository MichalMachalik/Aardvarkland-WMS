ALTER TABLE "wms_print_jobs"
  ADD COLUMN "carrier_label_id" UUID REFERENCES "carrier_labels"("id") ON DELETE SET NULL;

CREATE INDEX "wms_print_jobs_carrier_label_idx"
  ON "wms_print_jobs"("warehouse_id", "carrier_label_id", "created_at" DESC)
  WHERE "carrier_label_id" IS NOT NULL;

UPDATE "carrier_labels" label
SET "status" = 'GENERATED', "printed_at" = NULL, "updated_at" = now()
FROM "shipments" shipment
WHERE label."shipment_id" = shipment."id"
  AND label."warehouse_id" = shipment."warehouse_id"
  AND label."status" = 'PRINTED'
  AND label."printed_at" = shipment."shipped_at";

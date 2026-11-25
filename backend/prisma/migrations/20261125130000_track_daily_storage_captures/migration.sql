CREATE TABLE "storage_occupancy_captures" (
    "warehouse_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "storage_occupancy_captures_pkey" PRIMARY KEY ("warehouse_id", "client_id", "snapshot_date"),
    CONSTRAINT "storage_occupancy_captures_warehouse_id_fkey"
        FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "storage_occupancy_captures_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "wms_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

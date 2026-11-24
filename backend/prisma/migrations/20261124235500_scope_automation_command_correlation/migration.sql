CREATE UNIQUE INDEX "automation_commands_warehouse_id_correlation_id_key"
  ON "automation_commands" ("warehouse_id", "correlation_id");

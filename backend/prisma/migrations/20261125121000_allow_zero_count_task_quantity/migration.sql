ALTER TABLE warehouse_tasks
  DROP CONSTRAINT warehouse_tasks_quantity_positive_chk,
  ADD CONSTRAINT warehouse_tasks_quantity_positive_chk
    CHECK (quantity IS NULL OR quantity > 0 OR (type = 'COUNT' AND quantity = 0)) NOT VALID;

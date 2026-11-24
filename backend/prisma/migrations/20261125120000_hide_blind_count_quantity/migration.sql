UPDATE warehouse_tasks AS warehouse_task
SET quantity = NULL
FROM cycle_count_tasks AS count_task
WHERE count_task.warehouse_task_id = warehouse_task.id
  AND warehouse_task.type = 'COUNT'
  AND warehouse_task.metadata -> 'blindCount' = 'true'::jsonb
  AND warehouse_task.metadata #> '{releaseMetadata,hideExpectedFromRf}'
    IS DISTINCT FROM 'false'::jsonb;

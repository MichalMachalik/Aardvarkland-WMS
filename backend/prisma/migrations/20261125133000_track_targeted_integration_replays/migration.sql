ALTER TABLE "outbox_events" ADD COLUMN "target_endpoint_id" UUID;
ALTER TABLE "integration_dead_letters" ADD COLUMN "replay_outbox_event_id" UUID;

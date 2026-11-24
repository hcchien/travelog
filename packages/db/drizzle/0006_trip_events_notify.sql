-- 即時同步（ARCHITECTURE §6.3）：每筆活動紀錄都發出 NOTIFY。
-- NOTIFY 在交易 commit 後才送出，收到通知時資料一定已可讀。
CREATE OR REPLACE FUNCTION activity_log_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'trip_events',
    json_build_object(
      'id', NEW.id,
      'tripId', NEW.trip_id,
      'action', NEW.action,
      'actorId', NEW.actor_id,
      'via', NEW.via,
      'targetType', NEW.target_type,
      'targetId', NEW.target_id,
      'createdAt', NEW.created_at
    )::text
  );
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER activity_log_notify
  AFTER INSERT ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_notify();

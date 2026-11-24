-- 確定（釘選）行程點的資料庫層防線（ARCHITECTURE §5.5）。
-- 主要檢查在 @travelog/domain 的 assertItemMutable；這裡確保即使應用程式出錯，
-- 已確定行程點的鎖定欄位也不會被改動或刪除。
-- 解除確定（confirmed_at 改為 NULL）在資料庫層允許，權限由應用程式檢查。
-- 錯誤碼 TL423 由 API 轉成 HTTP 423。

CREATE OR REPLACE FUNCTION itinerary_items_guard_confirmed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- pg_trigger_depth() > 1 表示由外鍵連鎖刪除觸發（例如刪除整個行程），允許。
    IF OLD.confirmed_at IS NOT NULL AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'itinerary item % is confirmed and cannot be deleted', OLD.id
        USING ERRCODE = 'TL423';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT NULL AND (
       NEW.day_id     IS DISTINCT FROM OLD.day_id
    OR NEW.start_at   IS DISTINCT FROM OLD.start_at
    OR NEW.end_at     IS DISTINCT FROM OLD.end_at
    OR NEW.tz         IS DISTINCT FROM OLD.tz
    OR NEW.place_id   IS DISTINCT FROM OLD.place_id
    OR NEW.type       IS DISTINCT FROM OLD.type
    OR NEW.sort_key   IS DISTINCT FROM OLD.sort_key
    OR NEW.trip_id    IS DISTINCT FROM OLD.trip_id
  ) THEN
    RAISE EXCEPTION 'itinerary item % is confirmed; locked fields cannot change', OLD.id
      USING ERRCODE = 'TL423';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER itinerary_items_guard_confirmed
  BEFORE UPDATE OR DELETE ON itinerary_items
  FOR EACH ROW EXECUTE FUNCTION itinerary_items_guard_confirmed();

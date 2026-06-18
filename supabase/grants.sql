-- 이미 schema.sql을 실행한 뒤 "permission denied for table users" 가 나오면
-- Supabase SQL Editor에서 이 파일만 다시 Run 하세요.

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on users to anon, authenticated;
grant select, insert, update, delete on friends to anon, authenticated;
grant select, insert, update, delete on groups to anon, authenticated;
grant select, insert, update, delete on group_members to anon, authenticated;
grant select, insert, update, delete on safe_tracking to anon, authenticated;

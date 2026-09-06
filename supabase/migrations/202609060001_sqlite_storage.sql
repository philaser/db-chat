begin;

-- Privileged Node-only access; no public URLs or browser uploads.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dbchat-sqlite', 'dbchat-sqlite', false, 52428800, array['application/octet-stream']);

-- Deny browser roles even if another bucket has a permissive catch-all policy.
create policy dbchat_sqlite_server_only on storage.objects
as restrictive for all to anon, authenticated
using (bucket_id <> 'dbchat-sqlite')
with check (bucket_id <> 'dbchat-sqlite');

commit;

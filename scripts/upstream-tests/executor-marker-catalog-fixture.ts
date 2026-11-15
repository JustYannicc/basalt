import type { Client } from "pg";

/** Compare public catalog identities and definitions, not just the version marker. */
export async function publicCatalogFingerprint(client: Client): Promise<string> {
  const queries = [
    [
      "relations",
      `select c.oid::int as oid, c.relname, c.relkind, c.relfilenode::text as relfilenode,
          c.reltoastrelid::int as toast_relation_oid, c.reltablespace::int as tablespace_oid,
          c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity,
          c.reloptions, c.relacl::text as acl,
          case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end as definition,
          obj_description(c.oid, 'pg_class') as comment
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' order by c.oid`,
    ],
    [
      "columns",
      `select c.oid::int as relation_oid, a.attnum, a.attname, a.atttypid::int as type_oid,
          a.attlen, a.attalign, a.attstorage, a.attcompression, a.attcollation::int as collation_oid,
          a.atttypmod, a.attnotnull, a.attidentity, a.attgenerated, a.atthasdef,
          a.attislocal, a.attinhcount, a.attacl::text as acl,
          pg_get_expr(d.adbin, d.adrelid, true) as default_expression,
          col_description(a.attrelid, a.attnum) as comment
        from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
        order by c.oid, a.attnum`,
    ],
    [
      "indexes",
      `select i.indexrelid::int as oid, i.indrelid::int as table_oid, i.indisunique,
          i.indisprimary, i.indisexclusion, i.indisvalid, i.indisready, i.indislive,
          i.indisreplident, i.indisclustered, i.indnkeyatts, i.indnatts,
          i.indkey::text as keys, i.indclass::text as classes,
          i.indcollation::text as collations, i.indoption::text as options,
          pg_get_indexdef(i.indexrelid) as definition,
          obj_description(i.indexrelid, 'pg_class') as comment
        from pg_index i join pg_class c on c.oid = i.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' order by i.indexrelid`,
    ],
    [
      "constraints",
      `select c.oid::int as oid, c.conname, c.contype, c.conrelid::int as relation_oid,
          c.confrelid::int as referenced_relation_oid, c.conkey::text as keys,
          c.confkey::text as referenced_keys, c.condeferrable, c.condeferred,
          c.convalidated, c.conislocal, c.coninhcount,
          pg_get_constraintdef(c.oid, true) as definition,
          obj_description(c.oid, 'pg_constraint') as comment
        from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public' order by c.oid`,
    ],
    [
      "triggers",
      `select t.oid::int as oid, t.tgname, t.tgrelid::int as relation_oid,
          t.tgfoid::int as function_oid, t.tgtype, t.tgenabled, t.tgisinternal,
          encode(t.tgargs, 'hex') as arguments, pg_get_triggerdef(t.oid, true) as definition,
          obj_description(t.oid, 'pg_trigger') as comment
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' order by t.oid`,
    ],
    [
      "functions",
      `select p.oid::int as oid, p.proname, p.prokind, p.provolatile, p.proisstrict,
          p.prosecdef, p.proconfig, p.proacl::text as acl, p.proowner::int as owner,
          pg_get_function_identity_arguments(p.oid) as arguments,
          pg_get_function_result(p.oid) as result, pg_get_functiondef(p.oid) as definition,
          obj_description(p.oid, 'pg_proc') as comment
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind in ('f', 'p') order by p.oid`,
    ],
    [
      "types",
      `select t.oid::int as oid, t.typname, t.typtype, t.typcategory, t.typlen,
          t.typbyval, t.typnotnull, t.typbasetype::int as base_type_oid, t.typtypmod,
          t.typndims, t.typdefault, t.typacl::text as acl,
          array(select e.enumlabel from pg_enum e where e.enumtypid = t.oid
            order by e.enumsortorder) as enum_labels,
          obj_description(t.oid, 'pg_type') as comment
        from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' order by t.oid`,
    ],
    [
      "sequences",
      `select c.oid::int as oid, s.seqtypid::int as type_oid, s.seqstart, s.seqincrement,
          s.seqmax, s.seqmin, s.seqcache, s.seqcycle
        from pg_sequence s join pg_class c on c.oid = s.seqrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' order by c.oid`,
    ],
    [
      "policies",
      `select p.oid::int as oid, p.polname, p.polrelid::int as relation_oid, p.polcmd,
          p.polpermissive, p.polroles::text as roles,
          pg_get_expr(p.polqual, p.polrelid, true) as using_expression,
          pg_get_expr(p.polwithcheck, p.polrelid, true) as check_expression
        from pg_policy p join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' order by p.oid`,
    ],
    [
      "eventTriggers",
      `select e.oid::int as oid, e.evtname, e.evtevent, e.evtenabled,
          e.evtowner::int as owner, e.evtfoid::int as function_oid, e.evttags
        from pg_event_trigger e order by e.oid`,
    ],
  ] as const;
  const catalog: Record<string, unknown> = {};
  for (const [name, sql] of queries) catalog[name] = (await client.query(sql)).rows;
  return JSON.stringify(catalog);
}

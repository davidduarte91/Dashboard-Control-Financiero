# Checklist de ejecución: migración v1 → v2

No ejecutar hasta una revisión SQL final en Supabase y una copia de seguridad verificada.

1. Confirmar backup recuperable de Supabase y exportar `financial_entries` y `financial_lists`.
2. Poner v1 en sólo lectura y detener escrituras desde todos los dispositivos.
3. Ejecutar `node scripts/generate-v1-migration-preview.mjs` y confirmar 26/22/3/1/10 y conciliación exacta de aportes/retiros.
4. Revisar que no existan nuevas filas v1 desde la vista previa.
5. Ejecutar y validar `supabase-v2-schema.sql` en una transacción controlada.
6. Ejecutar y validar `supabase-v2-rpc-design.sql`; verificar permisos, RLS e inmutabilidad.
7. Revisar el plan de `supabase-v2-migration.sql` y ejecutar solamente tras aprobación explícita.
8. Ejecutar postchecks, reconstruir snapshots con la rutina administrativa revisada y verificar 22 contributions, 3 valuations, 10 posiciones y exclusión de `102bd81b`.
9. Validar lecturas v2 y UI en una sesión de prueba; no habilitar escrituras v2 todavía.
10. Si falla una validación, mantener v1 congelado y usar `supabase-v2-migration-rollback.sql` sólo tras comprobar que no hubo escrituras v2 ajenas.
11. Reconciliar otra vez los totales, aprobar resultados y recién entonces habilitar escrituras v2.

# Comiku repository agreement

- Current business rules: `docs/architecture.md`; UI: `DESIGN.md`, semantic tokens and Playground; API: controller-generated `docs/api/openapi.json`.
- Use Node.js 24.22.1, pnpm 9.1.2 and the root workspace/lockfile. Keep runtime pins and deployment images aligned.
- Resolve document conflicts before implementation. Do not duplicate state or role enums in pages or migrations.
- Reuse UI components and tokens; update Playground with shared patterns. Use Pointer Events and retain visible controls for core image operations.
- Enforce authorization, workflow transitions, revision/epoch checks and resource permissions on the server. Use module public services and external adapters.
- Never rewrite released migrations. Keep schema/migrations under `apps/server/prisma`; generated Prisma clients stay ignored. Follow `CONTRIBUTING.md` for isolated database tests.
- Generate API artifacts with `pnpm api:generate`; never hand-edit them. Explain schema, contract and lockfile impact in submissions.
- Ordinary tests and CI never call real X/R2. Keep secrets, real user files, database backups and local artifacts out of source control.
- Preserve unrelated work. Do not reset databases, delete volumes or rewrite history to fix local setup problems.
- Run affected type checks/builds and meaningful behavior tests; check desktop/narrow UI where applicable. Report actual verification, limitations and next steps. Git commits and external publication require user authorization.
- Project-owned code, docs and sample assets use MIT; preserve third-party notices.

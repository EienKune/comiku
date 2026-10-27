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
- Before starting work, read the tracked `docs/development/HANDOFF.md`. Keep reusable development pitfalls and verification boundaries there. Environment-specific deployment records, private experiments and session notes belong outside the public repository; public development instructions must not require untracked local files.
- Treat this as an open-source contribution: retain relevant source, synthetic fixtures and useful usage/architecture/configuration documentation. The example and BA image-analysis adapter implementations are public source. Model weights, secrets, real samples and environment-specific integration data must stay out of Git and Docker build contexts. Use documented configuration for model paths; keep implementation code separate from model artifacts.
- Keep an adapter's supporting runtime code, requirements and synthetic fixtures together with that adapter. Do not spread optional platform dependencies across unrelated business modules; default deployments must not pay for disabled optional runtimes.
- Before each authorized commit, inspect the complete staged diff and untracked-file list for private data, test artifacts and unrelated changes. Commit messages describe the problem and concrete changes only; Chinese is allowed. Keep verification records, deployment notes and remaining scope in the appropriate handoff or PR description instead of the commit message. Do not commit or push without user authorization, and do not infer that writing commit-message rules authorizes a commit.

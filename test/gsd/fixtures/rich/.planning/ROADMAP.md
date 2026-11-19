# Roadmap: Lumen Notes

## Milestones

- ✅ **v1.0 MVP** - Phases 1-2 (shipped 2026-03-02)
- 🚧 **v1.1 Sync & Sharing** - Phases 3-9 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-2) - SHIPPED 2026-03-02</summary>

### Phase 1: Local editor
**Goal**: A note can be written and saved offline
**Plans**: 1 plan

Plans:
- [x] 01-01: Editor shell

### Phase 2: Search
**Goal**: Notes can be found by their text
**Plans**: 1 plan

Plans:
- [x] 02-01: Full-text index

</details>

### 🚧 v1.1 Sync & Sharing (In Progress)

**Milestone Goal:** Notes follow the user across devices.

- [x] **Phase 3: Accounts** - Sign up and sign in
- [x] **Phase 4: Sync engine** - Notes sync between devices
- [ ] **Phase 5: Conflict handling** - Concurrent edits merge
- [ ] **Phase 6: Sharing links** - A note can be shared read-only
- [x] **Phase 6.1: Release notes hotfix (INSERTED)** - Fix the broken changelog page
- [ ] **Phase 7: Offline queue** - Edits made offline are kept
- [ ] **Phase 8: Launch polish** - Store listing and onboarding
- [ ] **Phase 9: Usage metrics** - Privacy-friendly counters

#### Phase 3: Accounts
**Goal**: A user can sign up, sign in and sign out
**Depends on**: Phase 2
**Plans**: 2 plans

#### Phase 4: Sync engine
**Goal**: A note edited on one device appears on the other within a minute
**Depends on**: Phase 3
**Plans**: 3 plans

#### Phase 5: Conflict handling
**Goal**: Two concurrent edits of one note never lose text
**Depends on**: Phase 4
**Plans**: 3 plans

#### Phase 6: Sharing links
**Goal**: A note can be shared through a read-only link
**Depends on**: Phase 4
**Plans**: 2 plans

#### Phase 6.1: Release notes hotfix (INSERTED)
**Goal**: The changelog page loads again
**Depends on**: Phase 6
**Plans**: 0 plans

#### Phase 7: Offline queue
**Goal**: Edits made offline are kept and sent later
**Depends on**: Phase 5
**Plans**: TBD

#### Phase 8: Launch polish
**Goal**: The store listing and onboarding are ready
**Depends on**: Phase 7
**Plans**: 1 plan

#### Phase 9: Usage metrics
**Goal**: Privacy-friendly usage counters exist
**Depends on**: Phase 8
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 3. Accounts | v1.1 | 2/2 | Complete | 2026-10-02 |
| 4. Sync engine | v1.1 | 3/3 | Complete | 2026-10-20 |
| 5. Conflict handling | v1.1 | 1/3 | In progress | - |
| 6. Sharing links | v1.1 | 0/2 | In progress | - |
| 6.1. Release notes hotfix | v1.1 | 0/0 | Complete | 2026-11-01 |
| 7. Offline queue | v1.1 | 0/0 | Not started | - |
| 8. Launch polish | v1.1 | 0/1 | Not started | - |
| 9. Usage metrics | v1.1 | 0/0 | Not started | - |

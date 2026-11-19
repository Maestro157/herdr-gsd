# Roadmap: Harbor Ledger

## Milestones

- 🚧 **v2.0 Statements** - Phases 1-3 (in progress)

## Phases

### 🚧 v2.0 Statements (In Progress)

- [x] **Phase 1: Ingest** - Bank files come in
- [ ] **Phase 2: Review** - A person checks each import
- [ ] **Phase 2.1: Bulk fixes (INSERTED)** - Many small corrections
- [ ] **Phase 3: Export** - Statements go out

#### Phase 1: Ingest
**Goal**: Bank statement files are imported without `manual` steps
**Depends on**: Nothing (first phase)
**Requirements**: ING-01, ING-02,
  ING-03
**Success Criteria** (what must be TRUE):
  1. A **CSV** file from the bank appears as transactions within a minute
  2. A broken file is rejected with a [clear message](https://example.com/help)
**Plans**: 2 plans

Plans:
- [x] 01-01: Parser
- [x] 01-02: Upload endpoint

#### Phase 2: Review
**Goal**: A person can approve or reject each import
**Depends on**: Phase 1
**Requirements**: REV-01
**Success Criteria** (what must be TRUE):
  1. An import waits for approval before it is booked
**Plans**: 1 plan

#### Phase 2.1: Bulk fixes (INSERTED)
**Goal**: Many small corrections land in one pass
**Depends on**: Phase 1, Phase 2
**Requirements**: TBD
**Plans**: 42 plans

#### Phase 3: Export
**Goal**: Statements can be exported as PDF
**Depends on**: Phase 2.1
**Requirements**: Covered by the export notes in CONTEXT.md, no IDs yet
**Plans**: TBD

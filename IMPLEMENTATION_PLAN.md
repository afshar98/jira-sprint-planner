# Implementation Plan: Jira Sprint Planner

## Goal

Build a standalone TypeScript web app that reads selected Jira Cloud Stories, generates one draft Jira Story per available workday, and only creates issues after the user reviews and approves the drafts.

## Decisions from the approved design

- A 10-day sprint with 8 available days generates 8 draft Stories; the remaining 2 days stay unplanned.
- Drafts are distributed across selected source Stories by scope and Jira priority.
- Each generated Story description contains a subtask checklist and Definition of Done (DoD). These checklist items are text, not separate Jira subtask issues.
- Each draft retains a reference to its source Story.
- The app uses TypeScript for both the web interface and server.
- The AI provider is replaceable. Generated content is always reviewed before Jira writes.

## Phases

### 1. Create the project foundation

- Initialize a TypeScript full-stack web app in this directory.
- Add app configuration, environment variable validation, and a short setup README.
- Define typed domain structures for source Stories, sprint inputs, generated drafts, subtasks, and DoD.

### 2. Add Jira Cloud connection and read flow

- Implement server-side OAuth connection and secure token storage.
- Add Jira API client functions to list accessible projects, sprints, and Stories, and to load selected Story details.
- Normalize Jira fields into an internal source Story model; handle missing optional fields.
- Display connection, permission, and Jira API errors in the app.

### 3. Implement task allocation and generation

- Validate sprint length and available days; require positive integer values and available days no greater than sprint length.
- Allocate exactly one generated draft per available day across selected source Stories using priority and scope.
- Generate structured drafts with title, one-day scope, description checklist, DoD, and source Story key.
- Validate the model response before displaying it; flag insufficient source detail and ask the user for context rather than inventing requirements.

### 4. Build the draft review flow

- Provide controls to select source Stories, target sprint, sprint length, and available days.
- Show generated drafts with source references and the subtask checklist and DoD clearly separated for editing.
- Let the user edit and regenerate drafts before approval.
- Do not write generated Stories to Jira during generation or editing.

### 5. Create approved Stories in Jira

- On explicit user approval, create each selected draft as a Jira Story in the target sprint.
- Include the source Story reference in the created Story and preserve the checklist and DoD in its description.
- Handle partial failures clearly: show which issues were created and allow retry of only the remaining drafts.
- Prevent accidental duplicate creation when a response is retried.

### 6. Finish the MVP

- Document required Jira permissions, OAuth setup, environment variables, and local run steps.
- Review the final changes for exposed credentials, unintended Jira writes, and unhandled partial failures.

## Out of scope for the first version

- Automatic issue creation without user approval.
- Calendar integrations, time-off scheduling, or automatic assignment to team members.
- Separate Jira subtask issue creation.
- Support for self-hosted Jira/Data Center until Jira Cloud behavior is established.

## Implementation order

Complete the phases in order. Keep the Jira API behind a server-side adapter and the generation service behind a provider-neutral interface so either can change without rewriting the review workflow.

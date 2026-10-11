# Jira Sprint Planner Design

## Purpose

A standalone web app connects to Jira, reads Stories selected by the user, and drafts new one-day Stories for a target sprint. The user reviews and edits the drafts before the app creates them in Jira.

## User flow

1. Connect a Jira Cloud account and select a project, target sprint, and multiple source Stories.
2. Enter the sprint length and the number of days available.
3. Generate exactly one draft Story per available day. For example, a 10-day sprint with 8 available days produces 8 drafts and leaves 2 days unplanned.
4. Allocate drafts across selected source Stories based on their scope and Jira priority.
5. Review and edit each draft, then create the approved Stories in the target sprint.

## Generated Story content

Each draft contains a concise title for roughly one day of work, a description with a subtask checklist and Definition of Done (DoD), and a reference to its source Jira Story. The checklist and DoD are text in the description, not separate Jira subtask issues. Source Stories remain unchanged. One-day sizing is a draft estimate for human review, not a guarantee.

## Technical direction

Use TypeScript for the web app and server. Keep Jira credentials on the server, fetch source details through Jira's API, and have an AI service return structured draft Stories for the review screen. Keep the AI provider replaceable.

## Behavior and error handling

- Reject invalid inputs, including available days greater than sprint length.
- If a source Story lacks enough detail, flag the draft for more context rather than inventing requirements.
- Show Jira connection, permission, and issue-creation failures clearly.
- Report partial issue-creation results so the user can distinguish created issues from drafts still pending.
- Only create issues after user approval.

## Out of scope

- Automatic creation without user approval.
- Calendar integrations, time-off scheduling, or automatic assignment.
- Creating separate Jira subtask issues.
- Self-hosted Jira/Data Center support in the first version.

## Acceptance criteria

- The user can select multiple source Stories and a target sprint.
- Available days cannot exceed sprint length.
- The app drafts exactly as many Stories as available days.
- Each draft includes a title, checklist, DoD, and source reference.
- The user can review and edit drafts before Jira is changed.
- Only approved drafts are created, and unallocated sprint days remain unplanned.

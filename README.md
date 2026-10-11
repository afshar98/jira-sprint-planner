# Jira Sprint Planner

A local web app that reads Jira Cloud Stories, drafts one new Story for each day you are available, and lets you review each draft before creating issues in a Jira sprint.

## Requirements

- Node.js 24.12 or later
- A Jira Cloud OAuth 2.0 (3LO) app
- An OpenAI API key for draft generation

## Setup

1. Copy `.env.example` to `.env`.
2. Create an OAuth 2.0 integration in the Atlassian developer console. Set the callback URL to `http://localhost:3000/auth/jira/callback` and add the app's client ID and secret to `.env`.
3. Grant the app `read:jira-work`, `write:jira-work`, `read:sprint:jira-software`, `write:sprint:jira-software`, and `offline_access` scopes.
4. Add your OpenAI API key to `.env`. Set `OPENAI_MODEL` to a model available to your account if the default is unavailable.
5. Start the app:

   ```sh
   npm run dev
   ```

6. Open `http://localhost:3000` and connect to Jira.

The app binds to localhost by default. OAuth tokens are held in server memory and are cleared when the app restarts. Keep `.env` private. Do not expose this local server to the public internet.

## How it works

- Select one Jira project, its board and target sprint, then select several source Stories from that sprint.
- Enter sprint days and available days. Available days determines how many draft Stories are generated.
- The app uses story scope and Jira priority to spread the drafts across the selected sources.
- Selected Jira Story details and the extra planning context are sent to the configured OpenAI API for drafting. The app requests that generation responses not be stored by the API.
- Each draft's Jira description contains a subtask checklist and a Definition of Done. These are checklist text, not nested Jira issues.
- Review and edit every draft before selecting **Create approved Stories**.
- Created issues are added to the selected sprint. If sprint placement fails after issue creation, the result shows the issue key so you can recover without creating it again.

This is a local MVP. It supports up to 40 draft Stories per plan and keeps sessions and pending drafts in memory, so restarting the server clears them. Generated one-day estimates are suggestions for review, not guarantees.

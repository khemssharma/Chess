# Security Policy

## Supported versions

Only the latest code on the `main` branch (and the current Render deployment built from it) receives security fixes. Older commits and forks are not supported.

## Reporting a vulnerability

Please **do not** open a public GitHub issue, discussion or pull request for security vulnerabilities.

Instead, report it privately using GitHub's [private vulnerability reporting](https://github.com/khemssharma/chess/security/advisories/new) (Security tab → Report a vulnerability), or contact the maintainer through their [GitHub profile](https://github.com/khemssharma).

Please include:

- A description of the issue and its potential impact
- Steps to reproduce, or a proof of concept
- Affected component (backend `src/`, WebSocket game server, `ui/`, Prisma schema) and commit or version
- Any suggested fix, if you have one

## What to expect

- Acknowledgement of your report within **7 days**
- An initial assessment and next steps within **14 days**
- Credit in the fix or advisory once it is released, unless you prefer to stay anonymous

Please give us reasonable time to fix the issue before disclosing it publicly.

## Scope

In scope: code in this repository, including the Express/WebSocket server, game and move validation logic, authentication, the React frontend and database access via Prisma.

Out of scope: vulnerabilities in third-party dependencies or services (Stockfish, AI providers, Render, the database host) — please report those upstream. Do not run load tests or denial-of-service attempts against the live deployment, and never access other players' accounts or data.

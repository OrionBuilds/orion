# Orion

Orion is an open-source operating system for running a service business with AI agents. It's the system of record that the agents in the Autom8ion Lab classroom (Clara, FRIDAY and Harvey) sign into and work from.

It runs entirely on your own accounts: a **Supabase** project for the database, storage, sign-in and server functions, and a **Netlify** site for the web app.

## What's in it

- **CRM:** contacts, companies, tags, custom fields, pipelines and opportunities
- **Delivery:** projects, project pipelines, tasks, support tickets, change requests and a client portal
- **Sales documents:** proposals, contracts with e-signature, invoices and payments
- **Scheduling:** calendars, appointment types and public booking pages with embeds
- **Communication:** conversations across email (Resend, Gmail, Microsoft 365), SMS and voice (Twilio)
- **AI agents:** per-agent model settings, an approval queue for anything risky, agent schedules, health and cost tracking
- **Operations:** custom values, brand kits, reporting, media storage, forms and surveys, memory
- **Modules for the agents:** Clara (executive assistant), FRIDAY (delivery), Harvey (outreach), plus Factory and Jason, which are still evolving

## Get started

Follow **[docs/SETUP.md](docs/SETUP.md)**. It takes a new install from nothing to your first sign-in.

## Before you build: security

Run the repository scanner before `npm install`, `npm run dev` or `npm run build` on code you've cloned or pulled:

```bash
bash scripts/security/check-repo.sh
```

Never commit `.env` files or API keys. Keys live in Supabase secrets, Supabase Vault and Netlify environment variables.

## Project layout

| Path | What it is |
|---|---|
| `src/` | The web app (React, TypeScript, Vite, Tailwind) |
| `supabase/migrations/` | The database schema and scheduled jobs |
| `supabase/setup.sql` | One-time setup for a new install |
| `supabase/functions/` | Edge functions (Deno) |
| `mcp-server/` | The MCP server the agents use to work in Orion |
| `packages/` | Embeddable booking, forms and web chat widgets |
| `scripts/` | Deployment and maintenance scripts |

## Learn to build with it

The free Autom8ion Lab community on Skool walks through setting up Orion and the agents step by step. [Join the community](https://www.skool.com/autom8ion-lab-7149).

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

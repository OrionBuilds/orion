# Setting up Orion

Orion runs on your own **Supabase** project (database, storage, sign-in and edge functions) and your own **Netlify** site (the web app). This guide takes a fresh install from nothing to your first sign-in.

You need: a GitHub account, a Supabase account, a Netlify account, a domain you control, Node.js 22, and the Supabase CLI (`npx supabase` works without installing it).

## 1. Get the code

Fork this repository on GitHub, then clone your fork:

```bash
git clone https://github.com/<you>/orion.git
cd orion
```

## 2. Create the Supabase project

1. In Supabase, create a new project. Save the database password in your password manager.
2. Note the **project ref**: the `abcdefghijklmnop` part of `https://abcdefghijklmnop.supabase.co`.
3. Link the CLI and push the database schema:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

This applies two migrations: the full Orion schema and its scheduled jobs. Apply them to a **new, empty** project only.

## 3. Add the Vault secrets

The scheduled jobs read three values from Supabase Vault. In Supabase go to **Project Settings → Vault** (or **Integrations → Vault**) and add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://<your-project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | your project's anon (public) key, from **Project Settings → API** |
| `cron_secret` | a long random string, e.g. the output of `openssl rand -hex 32` |

## 4. Run the first-time setup

Open `supabase/setup.sql`, change the two values at the top (your business name and the email domain you sign in with), then paste the whole file into the Supabase **SQL editor** and run it once.

It creates your organization, registers your email domain (only addresses on that domain can sign up), and loads roles, permissions, feature flags, departments and starter pipelines.

## 5. Set the edge function secrets

Copy `supabase/functions/.env.example` to `supabase/functions/.env`, fill in at least the **Required** section, then upload it:

```bash
npx supabase secrets set --env-file supabase/functions/.env
```

`CRON_SECRET` must be the **same value** as the Vault `cron_secret` from step 3. Never commit the `.env` file.

## 6. Deploy the edge functions

```bash
npx supabase functions deploy
```

This deploys every function in `supabase/functions`, using the per-function settings in `supabase/config.toml`.

## 7. Configure sign-in

In Supabase go to **Authentication → URL Configuration**:

- **Site URL:** your Orion address, e.g. `https://os.yourbusiness.com`
- **Redirect URLs:** add the same address with `/**` on the end

Email sign-in works out of the box. Google and Microsoft sign-in are optional; set them up under **Authentication → Providers** if you want them.

## 8. Deploy the web app on Netlify

1. In Netlify, **Add new site → Import an existing project**, and pick your fork.
2. Build command `npm run build`, publish directory `dist`.
3. Add the environment variables from `.env.example` at the root of the repo. The two required ones:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<your-project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | your anon key |

   Also set `VITE_COMPANY_NAME`, `VITE_COMPANY_EMAIL`, `VITE_COMPANY_PHONE` and `VITE_COMPANY_WEBSITE` so your proposals and invoices show your business, and `VITE_ORION_BRANDS` if you run more than one brand.

4. Deploy, then add your custom domain under **Domain management**.

## 9. First sign-in

1. Open your Orion address and sign up with an email on your registered domain. The first account gets the **Admin** role.
2. Make yourself SuperAdmin once, in the SQL editor:

```sql
UPDATE public.users
SET role_id = (SELECT id FROM public.roles WHERE name = 'SuperAdmin')
WHERE email = 'you@yourbusiness.com';
```

3. Sign out and back in. Then set up **MFA** under your profile.

## 10. Before you build anything: security

Before running `npm install`, `npm run dev` or `npm run build` on code you've cloned or pulled, run the repository scanner:

```bash
bash scripts/security/check-repo.sh
```

It looks for the signs of a known supply-chain worm that hides code in build config files and fake font files. If it reports anything, don't build: ask for help in the community.

## Updating Orion

Pull new versions from the upstream repository into your fork, run the security scanner, then:

```bash
npx supabase db push
npx supabase functions deploy
```

Netlify rebuilds the web app automatically when your fork's main branch changes.
